"""align: lay out the timeline from voice durations, run Whisper once over all narration,
place words and SFX cues, and flag segments where the TTS did not say the script."""

from __future__ import annotations

import json

from .. import legacy, media
from ..context import Ctx, TaskFailure
from ..text import tokens
from ..timeline import layout, place_cues, place_words, segment_qa

GAP_SEC = 0.8


def _fake_words(text: str, seconds: float) -> list[dict]:
    words = text.split()
    if not words:
        return []
    step = seconds / len(words)
    return [{"word": w, "start": round(i * step, 3), "end": round((i + 0.85) * step, 3)} for i, w in enumerate(words)]


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    refs: dict = ctx.payload.get("voice") or {}
    by_id = {s["id"]: s for s in ep["segments"]}
    files = {}
    durations: dict[str, float] = {}
    for seg_id, ref in refs.items():
        path = ctx.fetch(ref, f"voice for {seg_id}")
        files[seg_id] = path
        durations[seg_id] = media.duration(path)
    timeline = layout(ep, durations)
    ctx.progress(1, 3, "transcribing")

    words_by_seg: dict[str, list[dict]] = {}
    ordered = [s["id"] for s in timeline["segments"] if s["id"] in files]
    if ctx.config.dry_run:
        for seg_id in ordered:
            words_by_seg[seg_id] = _fake_words(by_id[seg_id]["narration"], durations[seg_id])
    elif ordered:
        # One Whisper pass over all narration (the model loads once), then split by offsets.
        joined = ctx.work / "narration.wav"
        inputs: list[str] = []
        parts = []
        for i, seg_id in enumerate(ordered):
            inputs += ["-i", str(files[seg_id])]
            parts.append(f"[{i}:a]aresample=16000,apad=pad_dur={GAP_SEC}[p{i}]")
        graph = ";".join(parts) + ";" + "".join(f"[p{i}]" for i in range(len(ordered))) + f"concat=n={len(ordered)}:v=0:a=1[out]"
        media.run([*inputs, "-filter_complex", graph, "-map", "[out]", "-ac", "1", str(joined)])
        offsets = {}
        t = 0.0
        for seg_id in ordered:
            offsets[seg_id] = (t, t + durations[seg_id] + GAP_SEC)
            t += durations[seg_id] + GAP_SEC
        try:
            heard = legacy.transcribe(joined, ctx.config.whisper_model)
        except SystemExit as exc:
            raise TaskFailure(f"Whisper unavailable: {exc}", retryable=False) from exc
        for w in heard:
            start = float(w["start"])
            for seg_id, (a, b) in offsets.items():
                if a <= start < b:
                    words_by_seg.setdefault(seg_id, []).append(
                        {"word": w["word"], "start": max(0.0, start - a), "end": max(0.0, float(w["end"]) - a)}
                    )
                    break
    ctx.check()

    place_words(timeline, words_by_seg)
    equal = None if ctx.config.dry_run else legacy.tokens_equivalent
    qa = segment_qa(ep, timeline, ctx.config.wer_flag_threshold, equal)
    warnings = place_cues(ep, timeline, equal)
    for row in qa:
        if row.get("flagged"):
            warnings.append(f"{row['segment_id']}: narration may be wrong (WER {row['wer']:.2f}). Heard: \"{row['transcript'][:200]}\"")
    ctx.warnings.extend(warnings)
    if any(len(tokens(by_id[s]["narration"])) > 0 and not words_by_seg.get(s) for s in ordered) and not ctx.config.dry_run:
        ctx.warnings.append("Whisper heard nothing in some segments; check the voice clips.")

    out = media.write_text(ctx.work / "timeline.json", json.dumps(timeline, indent=1))
    ctx.upload("timeline/main", out, duration_sec=timeline["total_duration"])
    ctx.progress(3, 3, "timeline ready")
    return {"segments": qa, "total_duration": timeline["total_duration"]}
