"""Local licensed SFX library (e.g. Sonniss GDC bundles, purchased packs, your own recordings).

Index a folder with:  python -m slideshow_worker index-sfx <folder> [<folder> ...]
Each folder must contain SFX_LICENSE.json, e.g.
  {"license": "Sonniss GDC royalty-free", "license_url": "https://sonniss.com/gdc-bundle-license/",
   "commercial_use": true, "attribution_required": false, "author": "Sonniss"}
Folders without it (or with commercial_use false) are refused, so nothing gets indexed by accident.
"""

from __future__ import annotations

import json
import re
import sqlite3
import subprocess
from pathlib import Path

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff", ".m4a"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS clips(
  path TEXT PRIMARY KEY, title TEXT, duration_sec REAL, license TEXT, license_url TEXT,
  attribution_required INTEGER, author TEXT, source_url TEXT, root TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(path UNINDEXED, words);
"""


def _words(path: Path, root: Path) -> str:
    rel = path.relative_to(root).with_suffix("")
    text = " ".join(rel.parts)
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    return re.sub(r"[^A-Za-z0-9]+", " ", text).lower().strip()


def _duration(path: Path) -> float | None:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None


def index(folders: list[Path], db_path: Path) -> int:
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    count = 0
    for root in folders:
        root = root.resolve()
        lic_file = root / "SFX_LICENSE.json"
        if not lic_file.exists():
            raise SystemExit(f"{root} has no SFX_LICENSE.json; refusing to index it.")
        lic = json.loads(lic_file.read_text(encoding="utf-8"))
        if not lic.get("commercial_use"):
            raise SystemExit(f"{root}: SFX_LICENSE.json does not allow commercial use; refusing.")
        db.execute("DELETE FROM clips_fts WHERE path IN (SELECT path FROM clips WHERE root = ?)", (str(root),))
        db.execute("DELETE FROM clips WHERE root = ?", (str(root),))
        for path in root.rglob("*"):
            if path.suffix.lower() not in AUDIO_EXT or not path.is_file():
                continue
            words = _words(path, root)
            db.execute(
                "INSERT OR REPLACE INTO clips VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    str(path), path.stem, _duration(path), lic.get("license", "licensed"), lic.get("license_url", ""),
                    1 if lic.get("attribution_required") else 0, lic.get("author", ""), lic.get("source_url", ""), str(root),
                ),
            )
            db.execute("INSERT INTO clips_fts(path, words) VALUES (?, ?)", (str(path), words))
            count += 1
    db.commit()
    db.close()
    return count


def search(query: str, db_path: Path, limit: int = 20) -> list[dict]:
    if not db_path.exists():
        return []
    terms = [t for t in re.sub(r"[^a-z0-9 ]+", " ", query.lower()).split() if len(t) > 1]
    if not terms:
        return []
    match = " OR ".join(f'"{t}"' for t in terms)
    db = sqlite3.connect(db_path)
    try:
        rows = db.execute(
            "SELECT c.path, c.title, c.duration_sec, c.license, c.license_url, c.attribution_required, c.author, c.source_url, f.words "
            "FROM clips_fts f JOIN clips c ON c.path = f.path WHERE clips_fts MATCH ? ORDER BY bm25(clips_fts) LIMIT ?",
            (match, limit),
        ).fetchall()
    finally:
        db.close()
    return [
        {
            "provider": "local",
            "source_id": Path(r[0]).name,
            "local_path": r[0],
            "title": r[1],
            "duration_sec": r[2],
            "license": r[3],
            "license_url": r[4],
            "attribution_required": bool(r[5]),
            "author": r[6],
            "source_url": r[7] or "",
            "tags": r[8].split(),
            "provider_bonus": 1.0,
        }
        for r in rows
    ]
