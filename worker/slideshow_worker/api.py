"""HTTP client for the site's worker API. Outbound HTTPS only; the site never calls the worker."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

import requests

from . import VERSION
from .config import Config, key_status

log = logging.getLogger(__name__)

CONTENT_TYPES = {
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".srt": "application/x-subrip",
    ".mp4": "video/mp4",
}


class LeaseLost(Exception):
    """The site no longer considers this worker the owner of the task. Stop immediately."""


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


class Api:
    def __init__(self, config: Config):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {config.token}",
                "X-Agent-Id": config.agent_id,
                "User-Agent": f"slideshow-worker/{VERSION}",
            }
        )

    def _request(self, method: str, path: str, *, json_body: Any = None, timeout: float = 60, retries: int = 4) -> Any:
        url = f"{self.config.base_url}{path}"
        delay = 2.0
        for attempt in range(retries + 1):
            try:
                res = self.session.request(method, url, json=json_body, timeout=timeout)
            except requests.RequestException as exc:
                if attempt == retries:
                    raise ApiError(0, f"{method} {path} failed: {exc}") from exc
                time.sleep(delay)
                delay *= 2
                continue
            if res.status_code == 204:
                return None
            body: Any
            try:
                body = res.json()
            except ValueError:
                body = {"error": res.text[:300]}
            if res.status_code == 409 and isinstance(body, dict) and body.get("code") == "lease_lost":
                raise LeaseLost(body.get("error", "lease lost"))
            if res.status_code == 429 or res.status_code >= 500:
                if attempt < retries:
                    wait = float(body.get("retry_after_sec", delay)) if isinstance(body, dict) else delay
                    time.sleep(wait)
                    delay *= 2
                    continue
            if not res.ok:
                message = body.get("error") if isinstance(body, dict) else str(body)
                raise ApiError(res.status_code, str(message))
            return body
        raise ApiError(0, "unreachable")

    # ── Queue ────────────────────────────────────────────────────────

    def claim(self, types: list[str] | None = None) -> dict | None:
        info = {
            "version": VERSION,
            "dry_run": self.config.dry_run,
            "keys": key_status(),
        }
        return self._request("POST", "/api/worker/tasks/next", json_body={"types": types or None, "info": info})

    def heartbeat(self, task: dict, progress: dict | None = None) -> None:
        self._request(
            "POST",
            f"/api/worker/tasks/{task['task_id']}/heartbeat",
            json_body={"lease_id": task["lease_id"], "progress": progress},
            retries=2,
        )

    def complete(self, task: dict, result: dict, asset_ids: list[str]) -> dict:
        return self._request(
            "POST",
            f"/api/worker/tasks/{task['task_id']}/complete",
            json_body={"lease_id": task["lease_id"], "result": result, "asset_ids": asset_ids},
            timeout=120,
        )

    def fail(self, task: dict, reason: str, retryable: bool = True) -> None:
        self._request(
            "POST",
            f"/api/worker/tasks/{task['task_id']}/fail",
            json_body={"lease_id": task["lease_id"], "reason": reason[:3900], "retryable": retryable},
        )

    # ── Files ────────────────────────────────────────────────────────

    def upload(self, task: dict, asset_key: str, path: Path, *, meta: dict | None = None, duration_sec: float | None = None,
               width: int | None = None, height: int | None = None) -> str:
        """Register, PUT to the presigned URL, return the asset id. Skips the PUT when identical bytes exist."""
        content_type = CONTENT_TYPES.get(path.suffix.lower())
        if not content_type:
            raise ValueError(f"No content type for {path.suffix}")
        body: dict[str, Any] = {
            "lease_id": task["lease_id"],
            "asset_key": asset_key,
            "content_type": content_type,
            "size_bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        if meta:
            body["meta"] = meta
        if duration_sec is not None:
            body["duration_sec"] = round(float(duration_sec), 3)
        if width:
            body["width"] = width
        if height:
            body["height"] = height
        slot = self._request("POST", f"/api/worker/tasks/{task['task_id']}/upload-url", json_body=body)
        if slot.get("already_present"):
            return slot["asset_id"]
        for attempt in range(4):
            try:
                with path.open("rb") as f:
                    res = requests.put(slot["upload_url"], data=f, headers={"content-type": content_type}, timeout=1800)
                if res.ok:
                    return slot["asset_id"]
                error = f"HTTP {res.status_code}: {res.text[:200]}"
            except requests.RequestException as exc:
                error = str(exc)
            time.sleep(2 ** attempt)
        raise ApiError(0, f"Upload of {asset_key} failed: {error}")

    def download(self, ref: dict, dest_dir: Path) -> Path:
        """Fetch an asset ref ({asset_id, url, sha256, content_type}); cached by sha256."""
        ext = next((e for e, t in CONTENT_TYPES.items() if t == ref.get("content_type")), ".bin")
        sha = ref.get("sha256")
        cache = self.config.cache_dir / "assets"
        cache.mkdir(parents=True, exist_ok=True)
        target = cache / f"{sha or ref['asset_id']}{ext}"
        if target.exists() and (not sha or sha256_file(target) == sha):
            return target
        tmp = target.with_suffix(target.suffix + ".part")
        with requests.get(ref["url"], stream=True, timeout=600) as res:
            if not res.ok:
                raise ApiError(res.status_code, f"download of {ref.get('asset_id')} failed")
            with tmp.open("wb") as f:
                for chunk in res.iter_content(1 << 20):
                    f.write(chunk)
        if sha and sha256_file(tmp) != sha:
            tmp.unlink(missing_ok=True)
            raise ApiError(0, f"checksum mismatch for asset {ref.get('asset_id')}")
        tmp.replace(target)
        dest_dir.mkdir(parents=True, exist_ok=True)
        return target


class Heartbeat:
    """Background heartbeats for one task. `progress()` updates what the next beat reports."""

    def __init__(self, api: Api, task: dict):
        self.api = api
        self.task = task
        self.every = max(10, int(task.get("heartbeat_every_seconds") or 60))
        self._progress: dict | None = None
        self._stop = threading.Event()
        self.lost = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def progress(self, completed: int | None = None, total: int | None = None, message: str | None = None) -> None:
        p: dict[str, Any] = {}
        if completed is not None:
            p["completed_items"] = completed
        if total is not None:
            p["total_items"] = total
        if message:
            p["message"] = message[:480]
        self._progress = p
        if self.lost.is_set():
            raise LeaseLost("lease lost")

    def _run(self) -> None:
        while not self._stop.wait(self.every):
            try:
                self.api.heartbeat(self.task, self._progress)
                self._progress = None
            except LeaseLost:
                log.warning("lease lost for task %s", self.task["task_id"])
                self.lost.set()
                return
            except Exception as exc:  # noqa: BLE001 - keep beating through transient errors
                log.warning("heartbeat failed: %s", exc)


def dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)
