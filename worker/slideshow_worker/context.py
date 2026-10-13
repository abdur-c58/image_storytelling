"""Per-task context handed to every stage."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .api import Api, Heartbeat
from .config import Config


class TaskFailure(Exception):
    """Fail the task with a clear reason. retryable=False sends it straight to dead-letter."""

    def __init__(self, reason: str, retryable: bool = True):
        super().__init__(reason)
        self.retryable = retryable


@dataclass
class Ctx:
    config: Config
    api: Api
    task: dict
    heartbeat: Heartbeat
    work: Path
    warnings: list[str] = field(default_factory=list)
    usage: list[dict[str, Any]] = field(default_factory=list)
    asset_ids: list[str] = field(default_factory=list)

    @property
    def payload(self) -> dict:
        return self.task["payload"]

    @property
    def episode(self) -> dict:
        return self.task["payload"]["episode"]

    def check(self) -> None:
        """Call between steps; raises LeaseLost if the heartbeat thread lost the lease."""
        self.heartbeat.progress()

    def progress(self, done: int, total: int, message: str | None = None) -> None:
        self.heartbeat.progress(done, total, message)

    def upload(self, asset_key: str, path: Path, **kwargs: Any) -> str:
        asset_id = self.api.upload(self.task, asset_key, path, **kwargs)
        self.asset_ids.append(asset_id)
        return asset_id

    def fetch(self, ref: dict | None, what: str) -> Path:
        if not ref:
            raise TaskFailure(f"Missing input: {what}.")
        return self.api.download(ref, self.work)

    def cleanup(self) -> None:
        shutil.rmtree(self.work, ignore_errors=True)
