/**
 * Phrase normalisation shared with the Python worker (worker/slideshow_worker/text.py).
 * Keep both implementations identical: lowercase, unify quotes, drop punctuation
 * except in-word apostrophes, collapse whitespace.
 */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function phraseInText(phrase: string, text: string): boolean {
  const needle = normalizePhrase(phrase);
  if (!needle) return false;
  return ` ${normalizePhrase(text)} `.includes(` ${needle} `);
}

/** Apply pronunciation overrides as whole-word, case-insensitive substitutions. */
export function applyPronunciations(text: string, overrides: Record<string, string>): string {
  let result = text;
  const keys = Object.keys(overrides).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![\\w'])${escaped}(?!\\w)`, "gi"), overrides[key]);
  }
  return result;
}
