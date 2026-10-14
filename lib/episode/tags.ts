import { normalizePhrase } from "./text";

/**
 * Fish Audio delivery tags inside `tts_text`:
 * - `[cue]` square-bracket cues (pauses, breaths, free-form directions), single, never nested;
 * - `<tag>…</tag>` paired angle tags that shape the words between them.
 * Shared with the worker's slideshow_worker/tags.py; keep the grammar identical.
 */
export type TagToken =
  | { kind: "text"; text: string; index: number }
  | { kind: "cue"; name: string; raw: string; index: number }
  | { kind: "open" | "close"; name: string; raw: string; index: number };

export interface TagProblem {
  index: number;
  message: string;
}

export interface ParsedTags {
  tokens: TagToken[];
  problems: TagProblem[];
}

const TAG_RE = /\[([^[\]]*)\]|<(\/?)([a-z][a-z-]*)>/gi;

export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function parseTags(input: string): ParsedTags {
  const tokens: TagToken[] = [];
  const problems: TagProblem[] = [];
  const stack: { name: string; index: number }[] = [];
  let last = 0;

  const pushText = (from: number, to: number) => {
    if (to <= from) return;
    const text = input.slice(from, to);
    for (const m of text.matchAll(/[[\]]/g)) {
      problems.push({ index: from + (m.index ?? 0), message: `Unbalanced "${m[0]}" in tts_text.` });
    }
    tokens.push({ kind: "text", text, index: from });
  };

  for (const m of input.matchAll(TAG_RE)) {
    const index = m.index ?? 0;
    pushText(last, index);
    last = index + m[0].length;
    if (m[1] !== undefined) {
      const name = normalizeTagName(m[1]);
      if (!name) problems.push({ index, message: "Empty [] tag." });
      else tokens.push({ kind: "cue", name, raw: m[0], index });
      continue;
    }
    const name = m[3].toLowerCase();
    if (m[2]) {
      const top = stack.pop();
      if (!top) problems.push({ index, message: `</${name}> closes a tag that was never opened.` });
      else if (top.name !== name) problems.push({ index, message: `</${name}> closes <${top.name}>; close tags in reverse order.` });
      tokens.push({ kind: "close", name, raw: m[0], index });
    } else {
      if (stack.some((s) => s.name === name)) problems.push({ index, message: `<${name}> is already open.` });
      stack.push({ name, index });
      tokens.push({ kind: "open", name, raw: m[0], index });
    }
  }
  pushText(last, input.length);
  for (const open of stack) problems.push({ index: open.index, message: `<${open.name}> is never closed.` });
  return { tokens, problems };
}

/** tts_text with every tag removed, whitespace collapsed. Compare with narration after normalizePhrase. */
export function stripTags(input: string): string {
  return input
    .replace(TAG_RE, " ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function ttsMatchesNarration(tts: string, narration: string): boolean {
  return normalizePhrase(stripTags(tts)) === normalizePhrase(narration);
}

/** Words of the first spot where the stripped tts_text and narration disagree, for a readable error. */
export function firstMismatch(tts: string, narration: string): { tts: string; narration: string } | null {
  const a = normalizePhrase(stripTags(tts)).split(" ");
  const b = normalizePhrase(narration).split(" ");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return { tts: a.slice(i, i + 4).join(" ") || "(end)", narration: b.slice(i, i + 4).join(" ") || "(end)" };
    }
  }
  return null;
}

export function countWords(text: string): number {
  const norm = normalizePhrase(text);
  return norm ? norm.split(" ").length : 0;
}

export interface TagStats {
  cues: string[];
  paired: string[];
  total: number;
}

export function tagStats(tokens: TagToken[]): TagStats {
  const cues = tokens.filter((t) => t.kind === "cue").map((t) => (t as { name: string }).name);
  const paired = tokens.filter((t) => t.kind === "open").map((t) => (t as { name: string }).name);
  return { cues, paired, total: cues.length + paired.length };
}

/**
 * Tag words Whisper heard that the narration does not contain, e.g. "pause" when Fish read "[pause]" aloud.
 * Only words from tags actually used in this tts_text count, so ordinary words are never flagged.
 */
export function spokenTagWords(tts: string, narration: string, transcript: string): string[] {
  const { tokens } = parseTags(tts);
  const tagWords = new Set(
    tokens
      .filter((t) => t.kind === "cue" || t.kind === "open")
      .flatMap((t) => normalizePhrase((t as { name: string }).name.replace(/-/g, " ")).split(" "))
      .filter((w) => w.length > 2),
  );
  if (!tagWords.size) return [];
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const w of normalizePhrase(text).split(" ")) if (w) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const said = count(narration);
  const heard = count(transcript);
  return [...tagWords].filter((w) => (heard.get(w) ?? 0) > (said.get(w) ?? 0));
}

export type TtsChunk = { kind: "speech"; text: string } | { kind: "silence"; ms: number };

/**
 * The split_and_silence fallback plan: speech chunks split at pause cues (each chunk keeps its own non-pause
 * cues and paired tags), with exact silences in between. Sentence gaps are not added here; the worker joins
 * sentences with `pause_between_sentences_ms` when it splits per sentence.
 */
export function splitAtPauses(tts: string, pauseDurations: Record<string, number>): TtsChunk[] {
  const durations = new Map(Object.entries(pauseDurations).map(([k, v]) => [normalizeTagName(k), v]));
  const out: TtsChunk[] = [];
  const { tokens } = parseTags(tts);
  let buf = "";
  const open: string[] = [];
  const flush = () => {
    let text = buf;
    for (let i = open.length - 1; i >= 0; i--) text += `</${open[i]}>`;
    const tidy = text
      .replace(/\s+/g, " ")
      .replace(/(<[a-z][a-z-]*>)\s+/gi, "$1")
      .replace(/\s+(<\/[a-z][a-z-]*>)/gi, "$1")
      .trim();
    if (stripTags(text)) out.push({ kind: "speech", text: tidy });
    buf = open.map((n) => `<${n}>`).join("");
  };
  for (const t of tokens) {
    if (t.kind === "cue" && durations.has(t.name)) {
      flush();
      const ms = durations.get(t.name)!;
      const prev = out[out.length - 1];
      if (prev?.kind === "silence") prev.ms += ms;
      else out.push({ kind: "silence", ms });
      continue;
    }
    if (t.kind === "text") buf += t.text;
    else buf += t.raw;
    if (t.kind === "open") open.push(t.name);
    if (t.kind === "close") open.pop();
  }
  flush();
  while (out[0]?.kind === "silence") out.shift();
  while (out[out.length - 1]?.kind === "silence") out.pop();
  return out;
}
