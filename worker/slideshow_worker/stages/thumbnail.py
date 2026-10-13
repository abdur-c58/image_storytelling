"""thumbnail_compose: base image + text layers → 1280×720 JPEG under YouTube's 2 MB limit."""

from __future__ import annotations

from .. import media
from ..context import Ctx, TaskFailure
from ..remotion import render_stills

MAX_BYTES = 2 * 1024 * 1024
QUALITIES = (90, 82, 72, 62)


def run(ctx: Ctx) -> dict:
    ep = ctx.episode
    bases: dict = ctx.payload.get("bases") or {}
    layers = [
        {
            "text": layer["text"],
            "style": layer.get("style", "impact_white_black_outline"),
            "position": layer.get("position", "top_center"),
            "max_font_size_px": layer.get("max_font_size_px", 200),
        }
        for layer in (ep.get("thumbnail") or {}).get("text_layers") or []
    ]
    variants = sorted(bases, key=int)
    if not variants:
        raise TaskFailure("No thumbnail base images are ready.")
    done = []
    for v in variants:
        out = None
        for quality in QUALITIES:
            path = ctx.work / f"thumbnail_{v}_q{quality}.jpg"
            props = {"baseImageUrl": bases[v]["url"], "textLayers": layers}
            render_stills(
                ctx.config.remotion_dir,
                [{"composition": "Thumbnail", "props": props, "output": str(path), "imageFormat": "jpeg", "jpegQuality": quality}],
                ctx.work,
            )
            if path.stat().st_size <= MAX_BYTES:
                out = path
                break
        if out is None:
            raise TaskFailure(f"Thumbnail {v} is still over 2 MB at the lowest quality.")
        w, h = media.image_size(out)
        if (w, h) != (1280, 720):
            raise TaskFailure(f"Thumbnail rendered at {w}x{h}, expected 1280x720.")
        ctx.upload(f"thumbnail/{v}", out, width=w, height=h)
        done.append(int(v))
        ctx.progress(len(done), len(variants))
    return {"variants": done}
