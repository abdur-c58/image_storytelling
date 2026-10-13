"""Text helpers. normalize_phrase must stay identical to lib/episode/text.ts normalizePhrase."""

from __future__ import annotations

import re
from typing import Callable


def normalize_phrase(text: str) -> str:
    t = text.lower()
    t = re.sub("[\u2018\u2019\u02bc]", "'", t)
    t = re.sub("[\u201c\u201d]", '"', t)
    t = re.sub(r"[^a-z0-9'\s]", " ", t)
    t = re.sub(r"(^|\s)'+|'+(?=\s|$)", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def tokens(text: str) -> list[str]:
    norm = normalize_phrase(text)
    return norm.split(" ") if norm else []


def apply_pronunciations(text: str, overrides: dict[str, str]) -> str:
    result = text
    for key in sorted(overrides, key=len, reverse=True):
        pattern = re.compile(r"(?<![\w'])" + re.escape(key) + r"(?!\w)", re.IGNORECASE)
        result = pattern.sub(lambda _m, v=overrides[key]: v, result)
    return result


def word_error_rate(reference: list[str], hypothesis: list[str], equal: Callable[[str, str], bool] | None = None) -> float:
    """Levenshtein distance over tokens divided by reference length."""
    if not reference:
        return 0.0 if not hypothesis else 1.0
    eq = equal or (lambda a, b: a == b)
    prev = list(range(len(hypothesis) + 1))
    for i, r in enumerate(reference, 1):
        cur = [i] + [0] * len(hypothesis)
        for j, h in enumerate(hypothesis, 1):
            cost = 0 if eq(r, h) else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[-1] / len(reference)


def find_phrase(phrase: str, words: list[dict], equal: Callable[[str, str], bool] | None = None) -> int | None:
    """Index of the first word where the phrase's tokens appear consecutively, or None."""
    needle = tokens(phrase)
    if not needle:
        return None
    eq = equal or (lambda a, b: a == b)
    hay = [normalize_phrase(str(w.get("word", ""))) for w in words]
    for i in range(len(hay) - len(needle) + 1):
        if all(eq(needle[k], hay[i + k]) for k in range(len(needle))):
            return i
    return None
