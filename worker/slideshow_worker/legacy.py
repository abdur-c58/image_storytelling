"""The only place the worker imports code from the existing Billions server (viewer/backend).

Keeping every import here means a rename in the server breaks one file, and `self_check()`
reports it at startup instead of halfway through a task.
"""

from __future__ import annotations

import dataclasses
import importlib
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

_modules: dict[str, ModuleType] = {}


def init(server_dir: Path) -> None:
    backend = server_dir / "viewer" / "backend"
    if not backend.is_dir():
        raise RuntimeError(f"SERVER_DIR does not contain viewer/backend: {server_dir}")
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def _mod(name: str) -> ModuleType:
    if name not in _modules:
        _modules[name] = importlib.import_module(name)
    return _modules[name]


REQUIRED = {
    "fish_audio_tts": ["load_fish_config", "synthesize_chunk", "FishTtsConfig"],
    "segment_timestamps": ["transcribe_audio", "tokens_equivalent"],
    "script_format": ["build_tts_text"],
    "export_video": ["detect_encoder", "encoder_args"],
    "hardware_monitor": ["resolve_whisper_device"],
}


def self_check(need_whisper: bool = False) -> list[str]:
    """Return a list of problems (empty when everything needed is importable)."""
    problems: list[str] = []
    for module, names in REQUIRED.items():
        try:
            mod = _mod(module)
        except Exception as exc:  # noqa: BLE001 - report any import failure
            problems.append(f"cannot import {module}: {exc}")
            continue
        for name in names:
            if not hasattr(mod, name):
                problems.append(f"{module}.{name} is missing")
    if need_whisper:
        try:
            importlib.import_module("whisper")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"openai-whisper not importable: {exc}")
    return problems


# ── Fish Audio ───────────────────────────────────────────────────────


def fish_config(*, voice_id: str = "", model: str = "", speed: float | None = None) -> Any:
    """Server config from env, with per-episode overrides."""
    base = _mod("fish_audio_tts").load_fish_config()
    changes: dict[str, Any] = {}
    if voice_id:
        changes["voice_id"] = voice_id
    if model:
        changes["model"] = model
    if speed is not None:
        changes["speed"] = float(speed)
    return dataclasses.replace(base, **changes) if changes else base


def fish_synthesize(text: str, config: Any) -> bytes:
    """MP3 bytes for one chunk (the server's payload: mp3, normalize, chunk_length from env)."""
    return _mod("fish_audio_tts").synthesize_chunk(text, config)


def tts_text_with_direction(text: str, delivery: str | None, default_direction: str) -> str:
    script = {"script": [{"segments": [{"segment_id": 1, "content": text, "delivery": delivery}]}]}
    return _mod("script_format").build_tts_text(script, default_direction)


# ── Whisper ──────────────────────────────────────────────────────────


def transcribe(audio_path: Path, model_name: str) -> list[dict[str, Any]]:
    """[{word, start, end}] using the server's Whisper setup (GPU when available)."""
    return _mod("segment_timestamps").transcribe_audio(audio_path, model_name)


def tokens_equivalent(a: str, b: str) -> bool:
    return bool(_mod("segment_timestamps").tokens_equivalent(a, b))


def whisper_device() -> tuple[str, dict[str, Any]]:
    return _mod("hardware_monitor").resolve_whisper_device()


# ── Video encoding ───────────────────────────────────────────────────


_encoder_name: str | None = None


def _encoder_works(args: list[str]) -> bool:
    import subprocess

    probe = ["ffmpeg", "-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30",
             "-frames:v", "5", *args, "-f", "null", "-"]
    return subprocess.run(probe, capture_output=True, timeout=60).returncode == 0


def detect_encoder(crf: int, maxrate: str = "12M", bufsize: str = "24M") -> tuple[str, list[str]]:
    """The server's encoder choice, verified once with a tiny test encode (an encoder can be listed
    by ffmpeg without a usable GPU behind it); falls back to libx264."""
    global _encoder_name
    ev = _mod("export_video")
    if _encoder_name is None:
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            name, args = ev.detect_encoder("auto", crf, maxrate, bufsize)
        _encoder_name = name if name == "libx264" or _encoder_works(args) else "libx264"
    return _encoder_name, ev.encoder_args(_encoder_name, crf, maxrate, bufsize)
