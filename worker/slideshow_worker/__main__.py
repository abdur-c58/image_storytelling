"""python -m slideshow_worker run [--once] | selfcheck | index-sfx <folder>..."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from . import VERSION
from .config import key_status, load_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="slideshow_worker", description=f"Slideshow storytelling worker {VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="poll the site and process tasks")
    run_p.add_argument("--once", action="store_true", help="exit when the queue is empty")
    sub.add_parser("selfcheck", help="check tools, server imports and which keys are set")
    idx = sub.add_parser("index-sfx", help="index a licensed local SFX folder (needs SFX_LICENSE.json)")
    idx.add_argument("folders", nargs="+", type=Path)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(threadName)s %(message)s")
    config = load_config()

    if args.command == "index-sfx":
        from .sfx import local

        count = local.index(args.folders, config.local_sfx_index)
        print(f"Indexed {count} clips into {config.local_sfx_index}")
        return 0

    from .runner import preflight, run

    problems = preflight(config)
    if args.command == "selfcheck":
        print(json.dumps({"version": VERSION, "dry_run": config.dry_run, "base_url": config.base_url,
                          "server_dir": str(config.server_dir), "keys": key_status(), "problems": problems}, indent=2))
        return 1 if problems else 0
    if problems:
        for p in problems:
            logging.error("preflight: %s", p)
        return 1
    return run(config, once=args.once)


if __name__ == "__main__":
    sys.exit(main())
