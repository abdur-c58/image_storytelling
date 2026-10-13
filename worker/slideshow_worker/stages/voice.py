"""voice: Fish Audio TTS per segment → trimmed mono 48 kHz FLAC. Loudness is set later in mix."""

from __future__ import annotations

import hashlib
import json
import os
import time

from .. import legacy, media
from ..context import Ctx, TaskFailure
from ..text import apply_pronunciations
from ..timeline import is_spoken, ordered_segments

# Models that understand a leading [direction] cue (the server already uses this with drama-3-preview).
DIRECTION_MODELS = ("drama", "s2")

TRIM = (
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,"
    "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.12,areverse"
)


def _synthesize(text: str, cfg: object, attempts: int = 3) -> bytes:
    delay = 5.0
    for attempt in range(attempts):
        try:
            return legacy.fish_synthesize(text, cfg)
        except RuntimeError as exc:
            message = str(exc)
            permanent = any(code in message for code in ("error 400", "error 401", "error 402", "error 403"))
            if permanent or attempt == attempts - 1:
                raise TaskFailure(f"Fish Audio: {message}", retryable=not permanent) from exc
            time.sleep(delay)
            delay *= 3
    raise TaskFailure("Fish Audio: no response")


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    voice = ep.get("voice") or {}
    wanted = ctx.payload.get("segment_ids")
    segs = [s for s in ordered_segments(ep) if is_spoken(s) and (not wanted or s["id"] in wanted)]
    overrides = voice.get("pronunciation_overrides") or {}

    cfg = None
    if not ctx.config.dry_run:
        if not os.environ.get("FISH_API_KEY"):
            raise TaskFailure("FISH_API_KEY is not set on the worker.", retryable=False)
        cfg = legacy.fish_config(voice_id=voice.get("voice_id", ""), model=voice.get("model", ""), speed=voice.get("speed"))
        if not getattr(cfg, "voice_id", ""):
            raise TaskFailure("No Fish voice: set voice.voice_id in the episode or FISH_VOICE_ID on the worker.", retryable=False)

    cache = ctx.config.cache_dir / "tts"
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    for i, seg in enumerate(segs):
        ctx.progress(i, len(segs), f"voice {seg['id']}")
        text = apply_pronunciations(seg.get("tts_text") or seg["narration"], overrides).strip()
        raw = ctx.work / f"{seg['id']}.mp3"
        if ctx.config.dry_run:
            seconds = max(1.0, len(text.split()) / 2.6)
            media.run(
                [
                    "-f", "lavfi", "-i", f"sine=frequency=170:sample_rate=48000:duration={seconds:.2f}",
                    "-af", "volume=0.25,tremolo=f=4:d=0.8", "-c:a", "libmp3lame", "-b:a", "128k", str(raw),
                ]
            )
        else:
            model = str(getattr(cfg, "model", ""))
            sent = text
            if model.startswith(DIRECTION_MODELS):
                sent = legacy.tts_text_with_direction(text, seg.get("delivery"), voice.get("style_notes") or getattr(cfg, "direction", ""))
            key = hashlib.sha256(
                json.dumps(
                    [sent, cfg.voice_id, model, cfg.speed, cfg.temperature, cfg.top_p, cfg.chunk_length], sort_keys=True
                ).encode()
            ).hexdigest()[:32]
            cached = cache / f"{key}.mp3"
            if not cached.exists():
                audio = _synthesize(sent, cfg)
                if len(audio) < 1000:
                    raise TaskFailure(f"Fish Audio returned almost no audio for {seg['id']}.")
                cached.write_bytes(audio)
                ctx.usage.append({"provider": "fish_audio", "unit": "characters", "quantity": len(sent), "meta": {"model": model}})
            raw = cached
        out = ctx.work / f"{seg['id']}.flac"
        media.run(["-i", str(raw), "-af", f"{TRIM},aresample=48000", "-ac", "1", "-c:a", "flac", str(out)])
        seconds = media.duration(out)
        if seconds < 0.3:
            raise TaskFailure(f"Voice for {seg['id']} is only {seconds:.2f}s after trimming.")
        ctx.upload(f"voice/{seg['id']}", out, duration_sec=seconds)
        results.append({"segment_id": seg["id"], "duration_sec": round(seconds, 3)})
        ctx.check()
    return {"segments": results}
