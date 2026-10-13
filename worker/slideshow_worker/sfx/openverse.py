"""Openverse audio search (https://api.openverse.org). Anonymous: ~1 request/second, page_size ≤ 20.

Optional OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET raise the rate limit.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

import requests

from . import ALLOWED_CC, ATTRIBUTION_REQUIRED, LICENSE_URLS

API = "https://api.openverse.org/v1"
CACHE_TTL_SEC = 7 * 24 * 3600

_lock = threading.Lock()
_last_call = 0.0
_token: tuple[str, float] | None = None


def _auth_header() -> dict[str, str]:
    global _token
    cid = os.environ.get("OPENVERSE_CLIENT_ID", "").strip()
    secret = os.environ.get("OPENVERSE_CLIENT_SECRET", "").strip()
    if not cid or not secret:
        return {}
    if _token and _token[1] > time.time() + 60:
        return {"Authorization": f"Bearer {_token[0]}"}
    res = requests.post(
        f"{API}/auth_tokens/token/",
        data={"grant_type": "client_credentials", "client_id": cid, "client_secret": secret},
        timeout=30,
    )
    if not res.ok:
        return {}
    body = res.json()
    _token = (body["access_token"], time.time() + float(body.get("expires_in", 3600)))
    return {"Authorization": f"Bearer {_token[0]}"}


def _throttle(min_interval: float) -> None:
    global _last_call
    with _lock:
        wait = _last_call + min_interval - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()


def search(query: str, cache_dir: Path, page_size: int = 20) -> list[dict]:
    params = {
        "q": query,
        "category": "sound_effect",
        "license": ",".join(sorted(ALLOWED_CC)),
        "page_size": str(min(20, page_size)),
        "mature": "false",
    }
    key = hashlib.sha256(json.dumps(params, sort_keys=True).encode()).hexdigest()[:24]
    cache = cache_dir / "openverse" / f"{key}.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < CACHE_TTL_SEC:
        results = json.loads(cache.read_text(encoding="utf-8"))
    else:
        headers = {"User-Agent": "slideshow-storytelling-worker/0.1", **_auth_header()}
        _throttle(0.25 if "Authorization" in headers else 1.1)
        res = requests.get(f"{API}/audio/", params=params, headers=headers, timeout=30)
        if res.status_code == 429:
            time.sleep(5)
            res = requests.get(f"{API}/audio/", params=params, headers=headers, timeout=30)
        res.raise_for_status()
        results = res.json().get("results", [])
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(results), encoding="utf-8")
    return [c for c in (_candidate(r) for r in results) if c]


def _candidate(r: dict) -> dict | None:
    license_code = str(r.get("license", "")).lower()
    if license_code not in ALLOWED_CC or not r.get("url"):
        return None
    version = r.get("license_version") or ""
    license_url = r.get("license_url") or LICENSE_URLS.get(license_code, "")
    if license_code == "by" and version and not license_url:
        license_url = f"https://creativecommons.org/licenses/by/{version}/"
    duration_ms = r.get("duration")
    return {
        "provider": "openverse",
        "source_id": str(r.get("id")),
        "title": (r.get("title") or "").strip(),
        "author": (r.get("creator") or "").strip(),
        "license": license_code,
        "license_version": version,
        "license_url": license_url,
        "source_url": r.get("foreign_landing_url") or "",
        "download_url": r["url"],
        "upstream_provider": r.get("provider") or r.get("source") or "",
        "duration_sec": (duration_ms / 1000.0) if isinstance(duration_ms, (int, float)) else None,
        "tags": [t.get("name", "") for t in (r.get("tags") or []) if isinstance(t, dict)],
        "attribution_required": license_code in ATTRIBUTION_REQUIRED,
    }
