"""Providers that are off by default.

Freesound: its API terms say commercial use of the API is negotiated case by case, so it is only
used when FREESOUND_ENABLED=1 (meaning you have that agreement). Only CC0 and CC BY sounds.

ElevenLabs sound generation: ELEVENLABS_SFX_ENABLED=1 plus ELEVENLABS_API_KEY. Generated clips are
licensed for commercial use on paid ElevenLabs plans; check your plan before enabling.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import requests

from . import LICENSE_URLS

FREESOUND_LICENSES = {
    "Creative Commons 0": ("cc0", False),
    "Attribution": ("by", True),
}


def freesound_search(query: str, limit: int = 15) -> list[dict]:
    key = os.environ.get("FREESOUND_API_KEY", "").strip()
    if not key:
        return []
    res = requests.get(
        "https://freesound.org/apiv2/search/text/",
        params={
            "query": query,
            "filter": 'license:("Creative Commons 0" OR "Attribution")',
            "fields": "id,name,username,license,url,duration,tags,previews",
            "page_size": str(limit),
            "token": key,
        },
        timeout=30,
    )
    res.raise_for_status()
    out = []
    for r in res.json().get("results", []):
        license_url = str(r.get("license", ""))
        if "publicdomain/zero" in license_url:
            lic_name = "Creative Commons 0"
        elif "/licenses/by/" in license_url:
            lic_name = "Attribution"
        else:
            continue
        code, attribution = FREESOUND_LICENSES[lic_name]
        out.append(
            {
                "provider": "freesound",
                "source_id": str(r["id"]),
                "title": r.get("name", ""),
                "author": r.get("username", ""),
                "license": code,
                "license_url": r.get("license") or LICENSE_URLS.get(code, ""),
                "source_url": r.get("url", ""),
                "download_url": (r.get("previews") or {}).get("preview-hq-mp3", ""),
                "duration_sec": r.get("duration"),
                "tags": r.get("tags") or [],
                "attribution_required": attribution,
            }
        )
    return [c for c in out if c["download_url"]]


def elevenlabs_generate(prompt: str, seconds: float | None, cache_dir: Path) -> dict | None:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return None
    duration = None if seconds is None else max(0.5, min(22.0, float(seconds)))
    digest = hashlib.sha256(f"{prompt}|{duration}".encode()).hexdigest()[:20]
    target = cache_dir / "elevenlabs" / f"{digest}.mp3"
    if not target.exists():
        body: dict = {"text": prompt, "prompt_influence": 0.4}
        if duration:
            body["duration_seconds"] = duration
        res = requests.post(
            "https://api.elevenlabs.io/v1/sound-generation",
            headers={"xi-api-key": key, "content-type": "application/json"},
            json=body,
            timeout=120,
        )
        if not res.ok:
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(res.content)
    return {
        "provider": "elevenlabs",
        "source_id": digest,
        "local_path": str(target),
        "title": prompt,
        "author": "ElevenLabs (generated)",
        "license": "elevenlabs-generated",
        "license_url": "https://elevenlabs.io/terms-of-use",
        "source_url": "",
        "duration_sec": duration,
        "tags": [],
        "attribution_required": False,
    }
