"""Batch still rendering through remotion/render-stills.mjs (one bundle, one browser)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .context import TaskFailure


def render_stills(remotion_dir: Path, jobs: list[dict], work: Path) -> None:
    if not (remotion_dir / "node_modules").exists():
        raise TaskFailure(f"Remotion dependencies missing: run `npm install` in {remotion_dir}.", retryable=False)
    node = shutil.which("node")
    if not node:
        raise TaskFailure("Node.js is not on PATH.", retryable=False)
    jobs_file = work / "remotion_jobs.json"
    jobs_file.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
    proc = subprocess.run(
        [node, str(remotion_dir / "render-stills.mjs"), str(jobs_file)],
        cwd=remotion_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
        check=False,
    )
    failures = []
    for line in proc.stdout.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not row.get("ok"):
            failures.append(f"{Path(row.get('output', '?')).name}: {row.get('error')}")
    if proc.returncode != 0 or failures:
        detail = "; ".join(failures) or proc.stderr[-1200:]
        raise TaskFailure(f"Remotion render failed: {detail}")
