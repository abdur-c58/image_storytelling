"""render: one clip per segment (motion + fades), joined with cuts/crossfades, muxed with the mix.

Crossfades extend the outgoing clip by the overlap so picture changes stay on the audio timeline.
"""

from __future__ import annotations

import json
from pathlib import Path

from .. import legacy, media
from ..context import Ctx, TaskFailure
from ..timeline import CROSSFADE_SEC, FADE_BLACK_SEC

W, H = 1920, 1080
COVER = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
ZOOM = 0.07


def _escape_filter_path(path: Path) -> str:
    value = path.resolve().as_posix()
    return value.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


def _motion_filter(motion: str, frames: int, fps: int) -> str | None:
    n = max(1, frames - 1)
    centre = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if motion == "slow_zoom_in":
        expr = f"z='1+{ZOOM}*on/{n}':{centre}"
    elif motion == "slow_zoom_out":
        expr = f"z='{1 + ZOOM}-{ZOOM}*on/{n}':{centre}"
    elif motion == "pan_left":
        expr = f"z='{1 + ZOOM}':x='(iw-iw/zoom)*(1-on/{n})':y='ih/2-(ih/zoom/2)'"
    elif motion == "pan_right":
        expr = f"z='{1 + ZOOM}':x='(iw-iw/zoom)*on/{n}':y='ih/2-(ih/zoom/2)'"
    else:
        return None
    # Upscale first so zoompan's integer positioning does not visibly jitter.
    return f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},zoompan={expr}:d={frames}:s={W}x{H}:fps={fps}"


def _clip(src: Path | None, dest: Path, seconds: float, fps: int, motion: str, fade_in: float, fade_out: float, enc: list[str]) -> None:
    frames = max(1, round(seconds * fps))
    fades = []
    if fade_in > 0:
        fades.append(f"fade=t=in:st=0:d={fade_in:.3f}")
    if fade_out > 0:
        fades.append(f"fade=t=out:st={max(0.0, frames / fps - fade_out):.3f}:d={fade_out:.3f}")
    tail = ",".join([*fades, "format=yuv420p"])
    if src is None:
        args = ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={fps}", "-vf", tail]
    else:
        zoom = _motion_filter(motion, frames, fps)
        if zoom:
            args = ["-i", str(src), "-vf", f"{zoom},{tail}"]
        else:
            args = ["-loop", "1", "-framerate", str(fps), "-i", str(src), "-vf", f"{COVER},fps={fps},{tail}"]
    media.run([*args, "-frames:v", str(frames), "-an", *enc, "-r", str(fps), str(dest)])


def _verify(path: Path, expected: float, fps: int) -> dict:
    info = media.probe(path)
    video = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    audio = next((s for s in info["streams"] if s.get("codec_type") == "audio"), None)
    dur = float(info["format"]["duration"])
    problems = []
    if not video or video.get("codec_name") != "h264":
        problems.append("video stream is not H.264")
    elif (int(video["width"]), int(video["height"])) != (W, H):
        problems.append(f"video is {video['width']}x{video['height']}")
    if not audio or audio.get("codec_name") != "aac":
        problems.append("audio stream is not AAC")
    if abs(dur - expected) > 0.5:
        problems.append(f"duration {dur:.2f}s, expected {expected:.2f}s")
    # Decode the last few seconds to catch truncated files.
    media.run(["-v", "error", "-ss", f"{max(0.0, dur - 5):.2f}", "-i", str(path), "-f", "null", "-"])
    return {
        "duration_sec": round(dur, 3),
        "video_codec": video.get("codec_name") if video else None,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": video.get("r_frame_rate") if video else None,
        "audio_codec": audio.get("codec_name") if audio else None,
        "size_bytes": int(info["format"].get("size", 0)),
        "problems": problems,
    }


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    render_cfg = ep.get("render") or {}
    timeline = json.loads(ctx.fetch(ctx.payload.get("timeline"), "timeline").read_text(encoding="utf-8"))
    audio = ctx.fetch(ctx.payload.get("mix_audio"), "mixed audio")
    display: dict = ctx.payload.get("display") or {}
    fps = int(timeline.get("fps", 30))
    total = float(timeline["total_duration"])
    segs = timeline["segments"]
    crf = int(render_cfg.get("crf", 18))
    encoder, final_enc = legacy.detect_encoder(crf)
    _, clip_enc = legacy.detect_encoder(max(10, crf - 4))

    clips: list[tuple[Path, float]] = []
    for i, seg in enumerate(segs):
        ctx.progress(i, len(segs) + 2, f"clip {seg['id']}")
        start = 0.0 if i == 0 else seg["start"]
        end = total if i == len(segs) - 1 else seg["end"]
        length = end - start
        xfade_out = seg["transition_out"] == "crossfade_150ms" and i < len(segs) - 1
        if xfade_out:
            length += CROSSFADE_SEC
        fade_out = FADE_BLACK_SEC if seg["transition_out"] == "fade_black" or i == len(segs) - 1 and timeline.get("outro_sec") else 0.0
        fade_in = FADE_BLACK_SEC if i > 0 and segs[i - 1]["transition_out"] == "fade_black" else 0.0
        ref = display.get(seg["id"])
        src = ctx.fetch(ref, f"picture for {seg['id']}") if ref else None
        if src is None and seg.get("display"):
            raise TaskFailure(f"{seg['id']}: picture {seg['display']} is not ready.")
        dest = ctx.work / f"clip_{i:03d}.mp4"
        _clip(src, dest, length, fps, seg.get("motion") or "none", fade_in, fade_out, clip_enc)
        clips.append((dest, length))
        ctx.check()

    # ── Join ────────────────────────────────────────────────────────
    ctx.progress(len(segs), len(segs) + 2, "encoding final video")
    inputs: list[str] = []
    for path, _ in clips:
        inputs += ["-i", str(path)]
    audio_index = len(clips)
    inputs += ["-i", str(audio)]
    # xfade needs both inputs on the same timebase; concat outputs 1/1000000, so every join is reset to 1/fps.
    tb = f"settb=1/{fps}"
    graph = [f"[{i}:v]fps={fps},{tb},setpts=PTS-STARTPTS[s{i}]" for i in range(len(clips))]
    current = "[s0]"
    merged = clips[0][1]
    for i in range(1, len(clips)):
        out = f"[m{i}]"
        if segs[i - 1]["transition_out"] == "crossfade_150ms":
            graph.append(f"{current}[s{i}]xfade=transition=fade:duration={CROSSFADE_SEC}:offset={merged - CROSSFADE_SEC:.3f},{tb}{out}")
            merged += clips[i][1] - CROSSFADE_SEC
        else:
            graph.append(f"{current}[s{i}]concat=n=2:v=1:a=0,{tb}{out}")
            merged += clips[i][1]
        current = out
    vf = [f"fps={fps}", "format=yuv420p"]
    captions = ctx.payload.get("captions")
    if render_cfg.get("burn_in_captions") and captions:
        srt = ctx.fetch(captions, "captions")
        local_srt = ctx.work / "captions.srt"
        local_srt.write_bytes(srt.read_bytes())
        style = "FontName=Arial,FontSize=22,Outline=2,Shadow=0,MarginV=40"
        if render_cfg.get("caption_style") == "bold_center":
            style = "FontName=Arial,FontSize=30,Bold=1,Outline=3,Alignment=5"
        vf.append(f"subtitles=filename='{_escape_filter_path(local_srt)}':force_style='{style}'")
    graph.append(f"{current}{','.join(vf)}[vout]")
    final = ctx.work / "final.mp4"
    graph_file = media.write_text(ctx.work / "render.filtergraph", ";".join(graph))
    abitrate = f"{int(render_cfg.get('audio_bitrate_kbps', 192))}k"
    media.run(
        [
            *inputs, "-/filter_complex", str(graph_file),
            "-map", "[vout]", "-map", f"{audio_index}:a",
            *final_enc, "-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", abitrate, "-ar", "48000",
            "-t", f"{total:.3f}", "-movflags", "+faststart", str(final),
        ],
        check_cancel=ctx.check,
    )
    verification = _verify(final, total, fps)
    if verification["problems"]:
        raise TaskFailure("Rendered video failed checks: " + "; ".join(verification["problems"]))

    preview = ctx.work / "preview.mp4"
    media.run(
        [
            "-i", str(final), "-vf", "scale=854:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(preview),
        ]
    )
    ctx.upload("video/final", final, duration_sec=verification["duration_sec"], width=W, height=H)
    ctx.upload("video/preview", preview, duration_sec=media.duration(preview))
    ctx.progress(len(segs) + 2, len(segs) + 2, "render complete")
    return {"duration_sec": verification["duration_sec"], "verification": {**verification, "encoder": encoder}}
