"""Worker configuration from environment variables (and an optional worker/.env file).

Secrets are read here and never logged. `key_status()` reports only whether each key is set.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = WORKER_DIR.parent

KEY_NAMES = (
    "WORKER_TOKEN",
    "FISH_API_KEY",
    "FISH_VOICE_ID",
    "OPENVERSE_CLIENT_ID",
    "OPENVERSE_CLIENT_SECRET",
    "FREESOUND_API_KEY",
    "ELEVENLABS_API_KEY",
)


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader; existing environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in os.environ:
            os.environ[key] = value


def _flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    base_url: str
    token: str
    agent_id: str
    server_dir: Path
    work_dir: Path
    remotion_dir: Path
    dry_run: bool
    whisper_model: str
    wer_flag_threshold: float
    freesound_enabled: bool
    elevenlabs_enabled: bool
    local_sfx_index: Path
    poll_interval_sec: float
    concurrency: int
    types: tuple[str, ...] = field(default_factory=tuple)
    keep_failed_work: bool = False

    @property
    def cache_dir(self) -> Path:
        return self.work_dir / ".cache"


def _str(name: str, default: str = "") -> str:
    """Empty counts as unset, so blank lines copied from .env.example keep the defaults."""
    return os.environ.get(name, "").strip() or default


def _path(name: str, default: Path) -> Path:
    """Relative paths are relative to the worker folder, not the current directory."""
    raw = _str(name)
    return (WORKER_DIR / raw).resolve() if raw else default.resolve()


def load_config() -> Config:
    _load_dotenv(WORKER_DIR / ".env")
    server_dir = _path("SERVER_DIR", REPO_DIR.parent / "server")
    # Reuse the existing server's .env.local for Fish Audio keys without copying secrets around.
    _load_dotenv(server_dir / ".env.local")
    types = tuple(t.strip() for t in _str("WORKER_TYPES").split(",") if t.strip())
    return Config(
        base_url=_str("APP_BASE_URL", "http://localhost:3000").rstrip("/"),
        token=_str("WORKER_TOKEN"),
        agent_id=_str("WORKER_AGENT_ID", _str("COMPUTERNAME", "worker")),
        server_dir=server_dir,
        work_dir=_path("WORK_DIR", WORKER_DIR / "work"),
        remotion_dir=_path("REMOTION_DIR", REPO_DIR / "remotion"),
        dry_run=_flag("DRY_RUN"),
        whisper_model=_str("WHISPER_MODEL", "small.en"),
        wer_flag_threshold=float(_str("WER_FLAG_THRESHOLD", "0.25")),
        freesound_enabled=_flag("FREESOUND_ENABLED") and bool(_str("FREESOUND_API_KEY")),
        elevenlabs_enabled=_flag("ELEVENLABS_SFX_ENABLED") and bool(_str("ELEVENLABS_API_KEY")),
        local_sfx_index=_path("LOCAL_SFX_INDEX", WORKER_DIR / "sfx_library.sqlite"),
        poll_interval_sec=float(_str("POLL_INTERVAL_SEC", "5")),
        concurrency=max(1, int(_str("WORKER_CONCURRENCY", "2"))),
        types=types,
        keep_failed_work=_flag("KEEP_FAILED_WORK"),
    )


def key_status() -> dict[str, bool]:
    return {name: bool(os.environ.get(name, "").strip()) for name in KEY_NAMES}
