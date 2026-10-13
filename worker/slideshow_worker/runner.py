"""Claim loop: poll the site, run one stage per leased task, report the result."""

from __future__ import annotations

import logging
import shutil
import threading
import time
import traceback
from typing import Callable

from . import legacy
from .api import Api, ApiError, Heartbeat, LeaseLost
from .config import Config
from .context import Ctx, TaskFailure
from .stages import align, cards, mix, render, sfx, thumbnail, voice

log = logging.getLogger(__name__)

STAGES: dict[str, Callable[[Ctx], dict]] = {
    "voice": voice.run,
    "align": align.run,
    "sfx": sfx.run,
    "cards": cards.run,
    "thumbnail_compose": thumbnail.run,
    "mix": mix.run,
    "render": render.run,
}


class Unauthorized(Exception):
    """The worker token was rejected; keep polling would only hammer the site."""


def preflight(config: Config) -> list[str]:
    problems: list[str] = []
    if not config.token:
        problems.append("WORKER_TOKEN is not set")
    for tool in ("ffmpeg", "ffprobe", "node"):
        if not shutil.which(tool):
            problems.append(f"{tool} not found on PATH")
    if not (config.remotion_dir / "node_modules").is_dir():
        problems.append(f"Remotion dependencies missing: run npm install in {config.remotion_dir}")
    try:
        legacy.init(config.server_dir)
        if not config.dry_run:
            problems += legacy.self_check(need_whisper=True)
    except RuntimeError as exc:
        problems.append(str(exc))
    return problems


def process(config: Config, api: Api, task: dict) -> None:
    kind = task["type"]
    work = config.work_dir / "tasks" / f"{task['task_id']}-{task.get('attempt', 0)}"
    work.mkdir(parents=True, exist_ok=True)
    log.info("start %s %s (%s) project=%s", kind, task["task_id"], task.get("scope"), task.get("project_title"))
    started = time.monotonic()
    ok = False
    with Heartbeat(api, task) as hb:
        ctx = Ctx(config=config, api=api, task=task, heartbeat=hb, work=work)
        try:
            stage = STAGES.get(kind)
            if stage is None:
                raise TaskFailure(f"This worker does not handle task type {kind}.", retryable=False)
            result = stage(ctx)
            ctx.check()
            api.complete(task, {**result, "warnings": ctx.warnings, "usage": ctx.usage}, ctx.asset_ids)
            ok = True
            log.info("done %s %s in %.1fs", kind, task["task_id"], time.monotonic() - started)
        except LeaseLost:
            log.warning("lease lost on %s %s; abandoning", kind, task["task_id"])
        except TaskFailure as exc:
            log.warning("failed %s %s: %s", kind, task["task_id"], exc)
            _fail(api, task, str(exc), exc.retryable)
        except ApiError as exc:
            if exc.status == 401:
                raise Unauthorized(str(exc)) from exc
            log.warning("API error on %s %s: %s", kind, task["task_id"], exc)
            _fail(api, task, f"Site API error: {exc}", True)
        except Exception as exc:  # noqa: BLE001 - every crash must reach the site as a failure
            log.error("crash in %s %s\n%s", kind, task["task_id"], traceback.format_exc())
            _fail(api, task, f"{type(exc).__name__}: {exc}", True)
        finally:
            if ok or not config.keep_failed_work:
                ctx.cleanup()


def _fail(api: Api, task: dict, reason: str, retryable: bool) -> None:
    try:
        api.fail(task, reason, retryable)
    except LeaseLost:
        pass
    except Exception as exc:  # noqa: BLE001
        log.error("could not report failure for %s: %s", task["task_id"], exc)


def run(config: Config, *, once: bool = False) -> int:
    api = Api(config)
    types = list(config.types) or list(STAGES)
    stop = threading.Event()
    exit_code = [0]
    slots = threading.Semaphore(config.concurrency)
    threads: list[threading.Thread] = []

    def work(task: dict) -> None:
        try:
            process(config, api, task)
        except Unauthorized as exc:
            log.error("worker token rejected (%s); stopping", exc)
            exit_code[0] = 2
            stop.set()
        finally:
            slots.release()

    log.info("worker %s polling %s for %s (dry_run=%s, concurrency=%d)",
             config.agent_id, config.base_url, ",".join(types), config.dry_run, config.concurrency)
    idle_wait = config.poll_interval_sec
    while not stop.is_set():
        slots.acquire()
        if stop.is_set():
            slots.release()
            break
        try:
            task = api.claim(types)
        except ApiError as exc:
            slots.release()
            if exc.status == 401:
                log.error("worker token rejected; stopping")
                return 2
            log.warning("claim failed: %s", exc)
            stop.wait(config.poll_interval_sec * 2)
            continue
        if not task:
            slots.release()
            if once and not any(t.is_alive() for t in threads):
                break
            # Each claim is a serverless invocation; back off while idle to stay inside plan quotas.
            stop.wait(idle_wait)
            idle_wait = min(idle_wait * 1.5, max(config.poll_max_interval_sec, config.poll_interval_sec))
            continue
        idle_wait = config.poll_interval_sec
        t = threading.Thread(target=work, args=(task,), daemon=True, name=f"task-{task['task_id'][:8]}")
        threads.append(t)
        t.start()
        threads = [x for x in threads if x.is_alive() or x is t]
    for t in threads:
        t.join()
    return exit_code[0]
