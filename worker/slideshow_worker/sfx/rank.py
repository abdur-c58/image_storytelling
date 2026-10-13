"""Candidate filtering and scoring shared by all providers."""

from __future__ import annotations

from ..text import tokens

ONE_SHOT_MAX_SEC = 12.0
BED_MIN_SEC = 4.0
HARD_MAX_SEC = 300.0


def is_bed(cue: dict) -> bool:
    return bool(cue.get("loop")) or cue.get("placement") == "whole_segment"


def acceptable(cue: dict, candidate: dict) -> bool:
    words = set(tokens(" ".join([candidate.get("title", ""), *candidate.get("tags", [])])))
    for tag in cue.get("exclude_tags") or []:
        if set(tokens(tag)) & words:
            return False
    for tag in cue.get("must_include_tags") or []:
        if not set(tokens(tag)) <= words:
            return False
    dur = candidate.get("duration_sec")
    if dur is not None:
        if dur <= 0.05 or dur > HARD_MAX_SEC:
            return False
        if is_bed(cue) and dur < 1.5:
            return False
    return True


def score(cue: dict, query: str, candidate: dict) -> float:
    q = set(tokens(query))
    title = set(tokens(candidate.get("title", "")))
    tags = set(tokens(" ".join(candidate.get("tags", []))))
    s = 3.0 * len(q & title) + 1.5 * len(q & tags)
    dur = candidate.get("duration_sec")
    if dur is not None:
        if is_bed(cue):
            s += 2.0 if dur >= BED_MIN_SEC else -1.0
        else:
            want = float(cue.get("duration_sec") or 2.0)
            s += 2.0 if dur <= ONE_SHOT_MAX_SEC else -2.0
            s -= min(2.0, abs(dur - want) / 5.0)
    if candidate.get("attribution_required"):
        s -= 0.5  # prefer clips that need no credit line
    return s + float(candidate.get("provider_bonus", 0))
