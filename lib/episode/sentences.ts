import { lineOnScreen, segmentLines } from "./lines";
import { stripTags } from "./tags";

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "st", "sr", "jr", "prof", "sgt", "capt", "lt", "col", "gen", "rev", "mt", "ft",
  "vs", "etc", "e.g", "i.e", "approx", "no", "vol", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
  "sept", "oct", "nov", "dec", "a.m", "p.m", "u.s", "u.k",
]);

const CLOSERS = `"'”’)]»`;

/**
 * Split narration into sentences. Handles honorific/common abbreviations, decimals (3.5), initials (J. R.),
 * ellipses (a sentence ends at "..." only when the next word starts with a capital) and closing quotes or
 * brackets after the terminator. Pure and deterministic; the worker never re-splits.
 */
export function splitSentences(text: string): string[] {
  const s = text.replace(/\s+/g, " ").trim();
  if (!s) return [];
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const isEllipsis = ch === "…" || (ch === "." && s.startsWith("...", i));
    if (ch !== "." && ch !== "!" && ch !== "?" && !isEllipsis) {
      i++;
      continue;
    }
    let end = i + 1;
    if (ch === "." && isEllipsis) end = i + 3;
    while (end < s.length && /[.!?…]/.test(s[end])) end++;
    while (end < s.length && CLOSERS.includes(s[end])) end++;
    const rest = s.slice(end);
    const next = rest.match(/^\s+(["'“‘(\[]*)(\S)/);
    if (end < s.length && !next) {
      i = end;
      continue;
    }
    if (ch === "." && !isEllipsis && end === i + 1) {
      const word = s.slice(start, i).split(" ").pop() ?? "";
      const bare = word.replace(/^["'“‘(\[]+/, "").toLowerCase();
      if (/\d$/.test(bare) && next && /\d/.test(next[2])) { i = end; continue; }
      if (ABBREVIATIONS.has(bare)) { i = end; continue; }
      if (/^[a-z]$/i.test(bare) && next && /[A-Z]/.test(next[2])) { i = end; continue; }
    }
    if (isEllipsis && next && !/[A-Z0-9]/.test(next[2])) {
      i = end;
      continue;
    }
    if (next && /[a-z]/.test(next[2]) && ch === ".") {
      i = end;
      continue;
    }
    out.push(s.slice(start, end).trim());
    start = end;
    i = end;
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** The sentences a segment is planned and timed by: the override if given, else the split narration. */
export function segmentSentences(seg: { narration: string; sentence_split_override?: string[] | null }): string[] {
  if (seg.sentence_split_override && seg.sentence_split_override.length) {
    return seg.sentence_split_override.map((x) => x.trim()).filter(Boolean);
  }
  return splitSentences(stripTags(seg.narration));
}

export interface SentenceUnit {
  text: string;
  line_id: string;
  line_index: number;
  speaker: string;
  /** The speaker is visible in frame (never the narrator). */
  on_screen: boolean;
}

/**
 * Sentences across all of a segment's lines, in order, each tagged with its line and speaker. A narration-only
 * segment keeps its sentence_split_override.
 */
export function segmentSentenceUnits(seg: Parameters<typeof segmentLines>[0] & { sentence_split_override?: string[] | null }): SentenceUnit[] {
  const lines = segmentLines(seg);
  return lines.flatMap((line, line_index) => {
    const texts = lines.length === 1 && seg.sentence_split_override?.length ? segmentSentences({ ...seg, narration: line.text }) : splitSentences(stripTags(line.text));
    return texts.map((text) => ({ text, line_id: line.id, line_index, speaker: line.speaker, on_screen: lineOnScreen(line) }));
  });
}
