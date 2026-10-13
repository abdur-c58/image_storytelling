"""Provider chain: Openverse → local library → Freesound (opt-in) → ElevenLabs (opt-in) → none."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import requests

from ..config import Config
from . import local, openverse
from .optional import elevenlabs_generate, freesound_search
from .rank import acceptable, score

log = logging.getLogger(__name__)
MAX_CANDIDATES = 5


def find_candidates(cue: dict, config: Config) -> tuple[list[dict], list[str]]:
    """Ranked candidates for a cue, plus warnings about providers that failed."""
    warnings: list[str] = []
    queries = [cue["search_query"], *(cue.get("alt_queries") or [])]
    pool: dict[str, dict] = {}

    def add(found: list[dict], query: str) -> None:
        for c in found:
            if not acceptable(cue, c):
                continue
            key = f"{c['provider']}:{c['source_id']}"
            c["score"] = round(score(cue, query, c), 2)
            if key not in pool or pool[key]["score"] < c["score"]:
                pool[key] = c

    for query in queries:
        try:
            add(openverse.search(query, config.cache_dir), query)
        except requests.RequestException as exc:
            warnings.append(f"Openverse search failed for \"{query}\": {exc}")
        add(local.search(query, config.local_sfx_index), query)
        if config.freesound_enabled:
            try:
                add(freesound_search(query), query)
            except requests.RequestException as exc:
                warnings.append(f"Freesound search failed: {exc}")
        if len(pool) >= MAX_CANDIDATES:
            break

    ranked = sorted(pool.values(), key=lambda c: c["score"], reverse=True)[:MAX_CANDIDATES]
    if not ranked and config.elevenlabs_enabled:
        generated = elevenlabs_generate(cue["search_query"], cue.get("duration_sec"), config.cache_dir)
        if generated:
            ranked = [generated]
    for c in ranked:
        c.pop("provider_bonus", None)
    return ranked, warnings


def fetch(candidate: dict, config: Config) -> Path:
    """Local file for a candidate (downloads and caches remote clips)."""
    if candidate.get("local_path"):
        path = Path(candidate["local_path"])
        if not path.exists():
            raise FileNotFoundError(f"Local clip missing: {path}")
        return path
    url = candidate.get("download_url")
    if not url:
        raise FileNotFoundError("Candidate has no download URL.")
    ext = Path(url.split("?")[0]).suffix.lower() or ".mp3"
    if len(ext) > 5:
        ext = ".mp3"
    digest = hashlib.sha256(url.encode()).hexdigest()[:20]
    target = config.cache_dir / "sfx" / f"{candidate['provider']}_{digest}{ext}"
    if target.exists() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=120, headers={"User-Agent": "slideshow-storytelling-worker/0.1"}) as res:
        res.raise_for_status()
        tmp = target.with_suffix(target.suffix + ".part")
        with tmp.open("wb") as f:
            for chunk in res.iter_content(1 << 16):
                f.write(chunk)
    tmp.replace(target)
    return target


def public_candidate(c: dict) -> dict:
    """What gets stored on the site: no local filesystem paths."""
    out = {k: v for k, v in c.items() if k != "local_path"}
    if c.get("local_path"):
        out["local_file"] = Path(c["local_path"]).name
    return out
