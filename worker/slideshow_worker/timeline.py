"""Episode timeline: segment timing, word placement, SFX cue anchors and captions.

Pure functions (no ffmpeg, no network) so they can be unit-tested.
"""

from __future__ import annotations

import re
from typing import Any, Callable

from .text import find_phrase, normalize_phrase, tokens, word_error_rate

DEFAULT_CARD_SECONDS = 2.5
DEFAULT_SILENT_SECONDS = 3.0
FADE_BLACK_SEC = 0.4
CROSSFADE_SEC = 0.15


def ordered_segments(ep: dict) -> list[dict]:
    return sorted(ep["segments"], key=lambda s: s["order"])


def is_card(seg: dict) -> bool:
    return seg["type"] in ("title_card", "infographic")


def is_spoken(seg: dict) -> bool:
    return not seg.get("silent") and bool(str(seg.get("narration", "")).strip())


def picture_source(ep: dict, seg: dict) -> str | None:
    """Segment id whose generated image this segment shows (follows reuse chains)."""
    by_id = {s["id"]: s for s in ep["segments"]}
    current = seg
    for _ in range(len(by_id) + 1):
        image = current.get("image") or {}
        if current.get("type") == "reuse_image":
            reuse = image.get("reuse_from_segment_id")
            if not reuse or reuse not in by_id:
                return None
            current = by_id[reuse]
            continue
        if image.get("prompt"):
            return current["id"]
        return None
    return None


def display_key(ep: dict, seg: dict) -> str | None:
    if is_card(seg):
        return f"card/{seg['id']}"
    src = picture_source(ep, seg)
    return f"image/{src}" if src else None


def layout(ep: dict, voice_durations: dict[str, float]) -> dict[str, Any]:
    """Assign start/end to every segment. Voice starts at the segment start; the pause follows it."""
    render = ep.get("render") or {}
    pause = (ep.get("voice") or {}).get("pause_between_segments_ms", 250) / 1000.0
    intro = float(render.get("intro_sec", 0) or 0)
    outro = float(render.get("outro_sec", 0) or 0)
    t = intro
    segs: list[dict[str, Any]] = []
    for seg in ordered_segments(ep):
        voice = voice_durations.get(seg["id"]) if is_spoken(seg) else None
        if voice is not None:
            length = voice + pause
        elif is_card(seg):
            length = DEFAULT_CARD_SECONDS
        else:
            length = DEFAULT_SILENT_SECONDS
        min_d = seg.get("min_duration_sec")
        if min_d:
            length = max(length, float(min_d))
        segs.append(
            {
                "id": seg["id"],
                "order": seg["order"],
                "type": seg["type"],
                "start": round(t, 3),
                "end": round(t + length, 3),
                "voice_start": round(t, 3) if voice is not None else None,
                "voice_duration": round(voice, 3) if voice is not None else None,
                "display": display_key(ep, seg),
                "motion": ((seg.get("image") or {}).get("motion") or "none") if not is_card(seg) else "none",
                "transition_out": seg.get("transition_out") or "cut",
                "caption_text": seg.get("caption_text"),
                "words": [],
            }
        )
        t += length
    return {
        "fps": int(render.get("fps", 30)),
        "intro_sec": intro,
        "outro_sec": outro,
        "content_end": round(t, 3),
        "total_duration": round(t + outro, 3),
        "segments": segs,
        "cues": [],
    }


def place_words(timeline: dict, words_by_segment: dict[str, list[dict]]) -> None:
    """Words come relative to each segment's own voice file; shift them onto the timeline."""
    for seg in timeline["segments"]:
        rel = words_by_segment.get(seg["id"]) or []
        if seg["voice_start"] is None:
            continue
        seg["words"] = [
            {
                "word": str(w.get("word", "")).strip(),
                "start": round(seg["voice_start"] + float(w["start"]), 3),
                "end": round(seg["voice_start"] + float(w["end"]), 3),
            }
            for w in rel
        ]


def segment_qa(ep: dict, timeline: dict, threshold: float, equal: Callable[[str, str], bool] | None = None) -> list[dict]:
    by_id = {s["id"]: s for s in ep["segments"]}
    out = []
    for seg in timeline["segments"]:
        src = by_id[seg["id"]]
        result: dict[str, Any] = {"segment_id": seg["id"], "start_sec": seg["start"], "end_sec": seg["end"]}
        if seg["voice_start"] is not None:
            ref = tokens(src.get("narration", ""))
            hyp = [t for w in seg["words"] for t in tokens(w["word"])]
            wer = word_error_rate(ref, hyp, equal)
            result.update(
                wer=round(wer, 3),
                transcript=" ".join(w["word"] for w in seg["words"]),
                flagged=bool(wer > threshold and len(ref) >= 4),
            )
        out.append(result)
    return out


def place_cues(ep: dict, timeline: dict, equal: Callable[[str, str], bool] | None = None) -> list[str]:
    """Resolve each SFX cue to an anchor time. Returns warnings."""
    warnings: list[str] = []
    segs = timeline["segments"]
    index = {s["id"]: i for i, s in enumerate(segs)}
    sfx_default = float((ep.get("audio") or {}).get("sfx_default_gain_db", -18))
    cues = []
    for src in ordered_segments(ep):
        seg = segs[index[src["id"]]]
        for cue in src.get("sfx") or []:
            placement = cue.get("placement", "segment_start")
            anchor = seg["start"]
            if placement == "segment_end":
                anchor = seg["end"]
            elif placement == "at_phrase":
                phrase = cue.get("at_phrase") or ""
                hit = find_phrase(phrase, seg["words"], equal) if seg["words"] else None
                if hit is None:
                    warnings.append(f"{cue['id']}: phrase \"{phrase}\" not heard in {seg['id']}; placed at segment start.")
                else:
                    anchor = seg["words"][hit]["start"]
            end = seg["end"]
            if cue.get("continues_into_next") and index[src["id"]] + 1 < len(segs):
                end = segs[index[src["id"]] + 1]["end"]
            cues.append(
                {
                    "cue_id": cue["id"],
                    "segment_id": seg["id"],
                    "placement": placement,
                    "anchor": round(anchor + float(cue.get("offset_sec") or 0), 3),
                    "segment_start": seg["start"],
                    "segment_end": round(end, 3),
                    "duration_sec": cue.get("duration_sec"),
                    "loop": bool(cue.get("loop")),
                    "gain_db": float(cue["gain_db"]) if cue.get("gain_db") is not None else sfx_default,
                    "fade_in_ms": int(cue.get("fade_in_ms", 100)),
                    "fade_out_ms": int(cue.get("fade_out_ms", 300)),
                    "continues_into_next": bool(cue.get("continues_into_next")),
                }
            )
    timeline["cues"] = cues
    return warnings


def cue_window(cue: dict, clip_len: float, total: float) -> tuple[float, float]:
    """Start/end of a cue on the timeline once the clip length is known."""
    if cue["placement"] == "whole_segment":
        start = cue["segment_start"] + (cue["anchor"] - cue["segment_start"])
        end = cue["segment_end"]
        if cue.get("duration_sec"):
            end = min(end, start + float(cue["duration_sec"]))
        return max(0.0, start), min(total, end)
    if cue["placement"] == "segment_end":
        start = max(cue["segment_start"], cue["anchor"] - clip_len)
    else:
        start = cue["anchor"]
    if cue.get("duration_sec"):
        length = float(cue["duration_sec"])
    elif cue["loop"]:
        length = cue["segment_end"] - start
    else:
        length = clip_len
    start = max(0.0, start)
    return start, min(total, start + max(0.05, length))


# ── Captions ─────────────────────────────────────────────────────────

MAX_CAPTION_CHARS = 42
MAX_CAPTION_SEC = 3.5


def _fmt(t: float) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _script_words(text: str) -> list[str]:
    return [w for w in re.split(r"\s+", text.strip()) if w]


def caption_cues(ep: dict, timeline: dict) -> list[tuple[float, float, str]]:
    """Caption lines using the script's spelling and Whisper's timing where the word counts line up."""
    by_id = {s["id"]: s for s in ep["segments"]}
    out: list[tuple[float, float, str]] = []
    for seg in timeline["segments"]:
        if seg["voice_start"] is None:
            continue
        src = by_id[seg["id"]]
        text = seg.get("caption_text") or src.get("narration", "")
        script = _script_words(text)
        if not script:
            continue
        v0 = seg["voice_start"]
        v1 = v0 + (seg["voice_duration"] or 0)
        heard = seg["words"]
        if len(heard) == len(script):
            timed = [(w, h["start"], h["end"]) for w, h in zip(script, heard)]
        else:
            total_chars = sum(len(w) + 1 for w in script)
            t = v0
            timed = []
            for w in script:
                d = (v1 - v0) * (len(w) + 1) / total_chars
                timed.append((w, t, t + d))
                t += d
        line: list[tuple[str, float, float]] = []
        for word, s, e in timed:
            candidate = " ".join(x[0] for x in line + [(word, s, e)])
            too_long = len(candidate) > MAX_CAPTION_CHARS or (line and e - line[0][1] > MAX_CAPTION_SEC)
            if line and too_long:
                out.append((line[0][1], line[-1][2], " ".join(x[0] for x in line)))
                line = []
            line.append((word, s, e))
            if word.endswith((".", "!", "?")):
                out.append((line[0][1], line[-1][2], " ".join(x[0] for x in line)))
                line = []
        if line:
            out.append((line[0][1], line[-1][2], " ".join(x[0] for x in line)))
    return out


def to_srt(cues: list[tuple[float, float, str]]) -> str:
    blocks = []
    for i, (s, e, text) in enumerate(cues, 1):
        blocks.append(f"{i}\n{_fmt(s)} --> {_fmt(max(e, s + 0.3))}\n{text}\n")
    return "\n".join(blocks)


def same_words(a: str, b: str) -> bool:
    return normalize_phrase(a) == normalize_phrase(b)
