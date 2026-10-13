"""cards: title cards and infographics rendered as 1920×1080 PNG stills with Remotion."""

from __future__ import annotations

from .. import media
from ..context import Ctx, TaskFailure
from ..remotion import render_stills
from ..timeline import is_card, ordered_segments

PROP_KEYS = ("title", "subtitle", "body", "background", "footer", "accent")


def card_props(seg: dict, background_url: str | None) -> dict:
    remotion = seg.get("remotion") or {}
    props = remotion.get("props") or {}
    out = {"template": remotion.get("template", "custom")}
    for key in PROP_KEYS:
        out[key] = props.get(key)
    out["background"] = props.get("background") or "dark"
    out["accent"] = props.get("accent") or "red"
    out["items"] = [
        {
            "label": str(item.get("label") or ""),
            "value": None if item.get("value") is None else str(item.get("value")),
            "icon": item.get("icon") or None,
            "icon_count": item.get("icon_count"),
            "icon_total": item.get("icon_total"),
        }
        for item in props.get("items") or []
    ]
    out["backgroundImageUrl"] = background_url if out["background"] == "image" else None
    return out


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    wanted = ctx.payload.get("segment_ids")
    backgrounds: dict = ctx.payload.get("backgrounds") or {}
    segs = [s for s in ordered_segments(ep) if is_card(s) and (not wanted or s["id"] in wanted)]
    jobs = []
    for seg in segs:
        bg = backgrounds.get(seg["id"])
        props = card_props(seg, bg["url"] if bg else None)
        if props["background"] == "image" and not props["backgroundImageUrl"]:
            raise TaskFailure(f"{seg['id']}: background image is not ready.")
        jobs.append({"composition": "Card", "props": props, "output": str(ctx.work / f"{seg['id']}.png"), "imageFormat": "png"})
    ctx.progress(0, len(jobs), "rendering cards")
    if jobs:
        render_stills(ctx.config.remotion_dir, jobs, ctx.work)
    for i, seg in enumerate(segs):
        path = ctx.work / f"{seg['id']}.png"
        w, h = media.image_size(path)
        if (w, h) != (1920, 1080):
            raise TaskFailure(f"{seg['id']}: card rendered at {w}x{h}, expected 1920x1080.")
        ctx.upload(f"card/{seg['id']}", path, width=w, height=h)
        ctx.progress(i + 1, len(segs))
    return {"cards": [s["id"] for s in segs]}
