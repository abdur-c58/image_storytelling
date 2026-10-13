"""mix: voice stem (normalised to the voice target) + SFX beds ducked under the voice + one-shots,
then two-pass loudnorm to the master target with a true-peak limiter. Writes mix_report.json and captions."""

from __future__ import annotations

import json
import math
from pathlib import Path

from .. import media
from ..context import Ctx, TaskFailure
from ..timeline import caption_cues, cue_window, to_srt

CLIP_REFERENCE_LUFS = -23.0
TOLERANCE_LU = 1.0
DUCK = "sidechaincompress=threshold=0.02:ratio=6:attack=15:release=350:makeup=1"


def _graph_file(work: Path, name: str, graph: str) -> list[str]:
    """Big filter graphs go in a file so the Windows command line stays short."""
    path = media.write_text(work / f"{name}.filtergraph", graph)
    return ["-/filter_complex", str(path)]


def _voice_stem(ctx: Ctx, timeline: dict, voice_refs: dict, total: float) -> Path:
    raw = ctx.work / "voice_raw.wav"
    spoken = [s for s in timeline["segments"] if s["voice_start"] is not None and s["id"] in voice_refs]
    if not spoken:
        media.run(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", f"{total:.3f}", "-c:a", "pcm_s24le", str(raw)])
        return raw
    inputs: list[str] = []
    parts = []
    for i, seg in enumerate(spoken):
        inputs += ["-i", str(ctx.fetch(voice_refs[seg["id"]], f"voice for {seg['id']}"))]
        delay = int(round(seg["voice_start"] * 1000))
        parts.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=delays={delay}:all=1[v{i}]")
    labels = "".join(f"[v{i}]" for i in range(len(spoken)))
    graph = ";".join(parts) + f";{labels}amix=inputs={len(spoken)}:normalize=0:dropout_transition=0,apad=whole_dur={total:.3f},atrim=0:{total:.3f}[out]"
    media.run([*inputs, *_graph_file(ctx.work, "voice", graph), "-map", "[out]", "-ac", "1", "-c:a", "pcm_s24le", str(raw)])
    return raw


def _loop_unit(src: Path, dest: Path, clip_len: float) -> Path:
    """Crossfade the clip's tail into its head so it loops without a click or gap."""
    x = max(0.05, min(0.5, clip_len / 4))
    graph = (
        f"[0:a]asplit=3[a][b][c];"
        f"[a]atrim={clip_len - x:.3f}:{clip_len:.3f},asetpts=PTS-STARTPTS,afade=t=out:d={x:.3f}[t];"
        f"[b]atrim=0:{x:.3f},asetpts=PTS-STARTPTS,afade=t=in:d={x:.3f}[h];"
        f"[t][h]amix=inputs=2:normalize=0[hx];"
        f"[c]atrim={x:.3f}:{clip_len - x:.3f},asetpts=PTS-STARTPTS[mid];"
        f"[hx][mid]concat=n=2:v=0:a=1[out]"
    )
    media.run(["-i", str(src), "-filter_complex", graph, "-map", "[out]", "-c:a", "flac", str(dest)])
    return dest


def _measure(path: Path, target: float, tp: float) -> dict[str, float]:
    m = media.measure_loudness(path, target, tp)
    return {"integrated_lufs": m["input_i"], "true_peak_dbtp": m["input_tp"], "lra": m["input_lra"], "threshold": m["input_thresh"]}


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    audio = ep.get("audio") or {}
    master_target = float(audio.get("master_loudness_lufs", -14))
    true_peak = float(audio.get("true_peak_db", -1.5))
    voice_target = float(audio.get("voice_target_lufs", -16))
    timeline = json.loads(ctx.fetch(ctx.payload.get("timeline"), "timeline").read_text(encoding="utf-8"))
    total = float(timeline["total_duration"])
    voice_refs: dict = ctx.payload.get("voice") or {}
    sfx_refs: dict = ctx.payload.get("sfx") or {}

    # ── Voice stem ──────────────────────────────────────────────────
    ctx.progress(0, 4, "voice stem")
    raw = _voice_stem(ctx, timeline, voice_refs, total)
    voice_before = media.measure_loudness(raw, voice_target, -2.0)
    voice = ctx.work / "voice.wav"
    media.run(["-i", str(raw), "-af", media.loudnorm_filter(voice_before, voice_target, -2.0) + ",aresample=48000", "-ac", "1", "-c:a", "pcm_s24le", str(voice)])
    ctx.check()

    # ── SFX placement ───────────────────────────────────────────────
    ctx.progress(1, 4, "placing sound effects")
    inputs: list[str] = ["-i", str(voice)]
    parts: list[str] = []
    beds: list[str] = []
    shots: list[str] = []
    rows = []
    k = 1
    for cue in timeline.get("cues", []):
        ref = sfx_refs.get(cue["cue_id"])
        if not ref:
            ctx.warnings.append(f"{cue['cue_id']}: no clip available; skipped in the mix.")
            continue
        meta = ref.get("meta") or {}
        if meta.get("provider") == "none":
            rows.append({"cue_id": cue["cue_id"], "skipped": "no licensed clip found"})
            continue
        clip = ctx.fetch(ref, f"sfx {cue['cue_id']}")
        clip_len = media.duration(clip)
        start, end = cue_window(cue, clip_len, total)
        length = end - start
        if length <= 0.05:
            rows.append({"cue_id": cue["cue_id"], "skipped": "falls outside the video"})
            continue
        looped = bool(cue["loop"]) and clip_len < length - 0.05
        if looped:
            unit = _loop_unit(clip, ctx.work / f"{cue['cue_id']}_loop.flac", clip_len)
            inputs += ["-stream_loop", "-1", "-i", str(unit)]
        else:
            inputs += ["-i", str(clip)]
        gain = voice_target + cue["gain_db"] - CLIP_REFERENCE_LUFS
        fade_in = min(cue["fade_in_ms"] / 1000.0, length / 2)
        fade_out = min(cue["fade_out_ms"] / 1000.0, length / 2)
        bus = "bed" if (cue["loop"] or cue["placement"] == "whole_segment" or length >= 4.0) else "shot"
        label = f"c{k}"
        parts.append(
            f"[{k}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{length:.3f},asetpts=PTS-STARTPTS,"
            f"volume={gain:.2f}dB,afade=t=in:st=0:d={fade_in:.3f},afade=t=out:st={max(0.0, length - fade_out):.3f}:d={fade_out:.3f},"
            f"adelay=delays={int(round(start * 1000))}:all=1[{label}]"
        )
        (beds if bus == "bed" else shots).append(label)
        rows.append(
            {
                "cue_id": cue["cue_id"],
                "segment_id": cue["segment_id"],
                "start_sec": round(start, 3),
                "end_sec": round(end, 3),
                "clip_sec": round(clip_len, 3),
                "looped": looped,
                "bus": bus,
                "ducked": bus == "bed",
                "gain_db_applied": round(gain, 2),
                "gain_db_relative_to_voice": cue["gain_db"],
                "provider": meta.get("provider"),
                "license": meta.get("license"),
            }
        )
        k += 1

    # ── Premix: voice + ducked beds + one-shots ─────────────────────
    ctx.progress(2, 4, "mixing")
    graph = list(parts)
    graph.append("[0:a]aformat=channel_layouts=stereo,asplit=2[vmix][vkey]")
    final_inputs = ["[vmix]"]
    if beds:
        graph.append("".join(f"[{b}]" for b in beds) + f"amix=inputs={len(beds)}:normalize=0:dropout_transition=0[bedsum]")
        graph.append(f"[bedsum][vkey]{DUCK}[ducked]")
        final_inputs.append("[ducked]")
    else:
        graph.append("[vkey]anullsink")
    if shots:
        graph.append("".join(f"[{s}]" for s in shots) + f"amix=inputs={len(shots)}:normalize=0:dropout_transition=0[shots]")
        final_inputs.append("[shots]")
    graph.append(
        "".join(final_inputs)
        + f"amix=inputs={len(final_inputs)}:normalize=0:duration=first:dropout_transition=0,atrim=0:{total:.3f}[pre]"
    )
    premix = ctx.work / "premix.wav"
    media.run([*inputs, *_graph_file(ctx.work, "mix", ";".join(graph)), "-map", "[pre]", "-c:a", "pcm_s24le", str(premix)])
    ctx.check()

    # ── Master: two-pass loudnorm + true-peak limiter ───────────────
    ctx.progress(3, 4, "mastering")
    limit = 10 ** (true_peak / 20.0)
    before = media.measure_loudness(premix, master_target, true_peak)
    master = ctx.work / "master.flac"
    chain = f"{media.loudnorm_filter(before, master_target, true_peak)},alimiter=limit={limit:.4f}:level=false,aresample=48000"
    media.run(["-i", str(premix), "-af", chain, "-ac", "2", "-sample_fmt", "s32", "-c:a", "flac", str(master)])
    after = _measure(master, master_target, true_peak)
    corrected = False
    if math.isfinite(after["integrated_lufs"]) and abs(after["integrated_lufs"] - master_target) > TOLERANCE_LU:
        fix = master_target - after["integrated_lufs"]
        fixed = ctx.work / "master_fixed.flac"
        media.run(["-i", str(master), "-af", f"volume={fix:.2f}dB,alimiter=limit={limit:.4f}:level=false", "-sample_fmt", "s32", "-c:a", "flac", str(fixed)])
        master = fixed
        after = _measure(master, master_target, true_peak)
        corrected = True
    passed = abs(after["integrated_lufs"] - master_target) <= TOLERANCE_LU and after["true_peak_dbtp"] <= true_peak + 0.5

    report = {
        "targets": {"master_lufs": master_target, "true_peak_dbtp": true_peak, "voice_lufs": voice_target, "tolerance_lu": TOLERANCE_LU},
        "duration_sec": total,
        "voice": {"before_lufs": voice_before.get("input_i"), "target_lufs": voice_target},
        "premix": {"integrated_lufs": before.get("input_i"), "true_peak_dbtp": before.get("input_tp"), "lra": before.get("input_lra")},
        **after,
        "gain_correction_pass": corrected,
        "cues": rows,
        "ducking": DUCK,
        "passed": passed,
        "warnings": list(ctx.warnings),
    }
    report_path = media.write_text(ctx.work / "mix_report.json", json.dumps(report, indent=2))
    if not passed:
        raise TaskFailure(
            f"Master is {after['integrated_lufs']:.1f} LUFS / {after['true_peak_dbtp']:.1f} dBTP; "
            f"target {master_target} LUFS ±{TOLERANCE_LU} and ≤ {true_peak} dBTP.",
            retryable=False,
        )

    ctx.upload("mix/audio", master, duration_sec=media.duration(master))
    ctx.upload("mix/report", report_path)
    srt = to_srt(caption_cues(ep, timeline))
    if srt.strip():
        ctx.upload("captions/srt", media.write_text(ctx.work / "captions.srt", srt))
    ctx.progress(4, 4, "mix ready")
    return {"report": {k: report[k] for k in ("integrated_lufs", "true_peak_dbtp", "lra", "passed", "gain_correction_pass")}}
