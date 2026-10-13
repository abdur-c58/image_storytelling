"""sfx: find a licensed clip per cue, normalise it (−23 LUFS, or peak for short clips) and upload."""

from __future__ import annotations

from .. import media
from ..context import Ctx
from ..sfx.chain import fetch, find_candidates, public_candidate
from ..sfx.rank import is_bed
from ..timeline import ordered_segments

ONE_SHOT_CAP_SEC = 20.0
BED_CAP_SEC = 120.0


def _dry_clip(ctx: Ctx, cue: dict) -> tuple[list[dict], str]:
    path = ctx.work / f"{cue['id']}_src.wav"
    if is_bed(cue):
        media.run(["-f", "lavfi", "-i", "anoisesrc=color=pink:sample_rate=48000:duration=6", "-af", "lowpass=f=900,volume=0.3", str(path)])
    else:
        media.run(["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=0.4", "-af", "afade=t=out:st=0.1:d=0.3", str(path)])
    cand = {
        "provider": "dry_run",
        "source_id": cue["id"],
        "title": f"{cue['search_query']} (dry run)",
        "author": "dry run",
        "license": "cc0",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "source_url": "",
        "attribution_required": False,
        "local_path": str(path),
    }
    return [cand], str(path)


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    wanted = ctx.payload.get("cue_ids")
    selections = ctx.payload.get("selections") or {}
    use_selection = bool(ctx.payload.get("use_selection"))
    cues = [(seg["id"], cue) for seg in ordered_segments(ep) for cue in (seg.get("sfx") or []) if not wanted or cue["id"] in wanted]
    out_rows = []
    for i, (seg_id, cue) in enumerate(cues):
        ctx.progress(i, len(cues), f"sfx {cue['id']}")
        selected = selections.get(cue["id"]) if use_selection else None
        if ctx.config.dry_run:
            candidates, _ = _dry_clip(ctx, cue)
            index = 0
        elif selected and selected.get("candidates"):
            candidates = selected["candidates"]
            index = int(selected.get("selected_index", 0))
        else:
            candidates, warnings = find_candidates(cue, ctx.config)
            ctx.warnings.extend(warnings)
            index = 0

        clip = None
        tried = 0
        while candidates and index < len(candidates):
            try:
                clip = fetch(candidates[index], ctx.config)
                break
            except Exception as exc:  # noqa: BLE001 - try the next candidate
                ctx.warnings.append(f"{cue['id']}: candidate {index + 1} unusable ({exc}); trying the next one.")
                index += 1
                tried += 1

        target = ctx.work / f"{cue['id']}.flac"
        if clip is None:
            ctx.warnings.append(f"{cue['id']}: no commercially licensed clip found for \"{cue['search_query']}\"; using silence.")
            media.silence(target, 1.0)
            meta = {"provider": "none", "license": "none", "attribution_required": False, "title": "silence"}
            index = 0
            candidates = []
        else:
            cap = BED_CAP_SEC if is_bed(cue) else ONE_SHOT_CAP_SEC
            if cue.get("duration_sec") and not cue.get("loop"):
                cap = min(cap, float(cue["duration_sec"]))
            stats = media.normalize_clip(clip, target, max_duration=cap)
            chosen = candidates[index]
            meta = {
                k: chosen.get(k, "")
                for k in ("provider", "source_id", "title", "author", "license", "license_url", "source_url", "attribution_required")
            }
            meta["normalization"] = stats
        ctx.upload(f"sfx/{cue['id']}", target, meta=meta, duration_sec=media.duration(target))
        out_rows.append(
            {
                "cue_id": cue["id"],
                "segment_id": seg_id,
                "candidates": [public_candidate(c) for c in candidates],
                "selected_index": index,
            }
        )
        ctx.check()
    return {"cues": out_rows}
