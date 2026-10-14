import { normalizePhrase } from "@/lib/episode/text";

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface SentenceTiming {
  index: number;
  text: string;
  start_sec: number;
  end_sec: number;
  /** Schema 2.1: which line and speaker the sentence belongs to. */
  line_id?: string;
  speaker?: string;
  on_screen?: boolean;
}

const tokens = (text: string) => normalizePhrase(text).split(" ").filter(Boolean);

/**
 * Index of the heard word each script token lines up with (or -1), via a Levenshtein alignment.
 * Substitutions count as aligned: the position is what matters for timing, not the spelling.
 */
export function alignTokens(script: string[], heard: string[]): number[] {
  const n = script.length;
  const m = heard.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = dp[i - 1][j - 1] + (script[i - 1] === heard[j - 1] ? 0 : 1);
      dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const sub = dp[i - 1][j - 1] + (script[i - 1] === heard[j - 1] ? 0 : 1);
    if (dp[i][j] === sub) {
      out[i - 1] = j - 1;
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return out;
}

/**
 * Start/end of every sentence on the timeline. Sentences map onto Whisper's words through a token alignment;
 * a sentence with no aligned words gets a share of the voice window proportional to its length.
 */
export function timeSentences(
  sentences: string[],
  words: TimedWord[],
  voiceStart: number,
  voiceEnd: number,
): SentenceTiming[] {
  const sentTokens = sentences.map(tokens);
  const flat = sentTokens.flat();
  const heardTokens: { token: string; word: number }[] = [];
  words.forEach((w, wi) => tokens(w.word).forEach((t) => heardTokens.push({ token: t, word: wi })));
  const links = alignTokens(flat, heardTokens.map((h) => h.token));

  const raw: (SentenceTiming | null)[] = [];
  let k = 0;
  sentTokens.forEach((toks, index) => {
    const hits = toks.map((_, ti) => links[k + ti]).filter((x) => x >= 0).map((x) => heardTokens[x].word);
    k += toks.length;
    if (!hits.length) {
      raw.push(null);
      return;
    }
    raw.push({ index, text: sentences[index], start_sec: words[Math.min(...hits)].start, end_sec: words[Math.max(...hits)].end });
  });

  // Fill gaps proportionally between known neighbours (or the voice window edges).
  const weight = sentTokens.map((t) => Math.max(1, t.length));
  const out: SentenceTiming[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i]) {
      out.push(raw[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < raw.length && !raw[j]) j++;
    const from = i > 0 ? out[i - 1].end_sec : voiceStart;
    const to = j < raw.length ? raw[j]!.start_sec : voiceEnd;
    const total = weight.slice(i, j).reduce((a, b) => a + b, 0);
    let t = from;
    for (let x = i; x < j; x++) {
      const d = (Math.max(0, to - from) * weight[x]) / total;
      out.push({ index: x, text: sentences[x], start_sec: t, end_sec: t + d });
      t += d;
    }
    i = j;
  }
  // Keep sentences ordered and non-overlapping even if Whisper's words are not.
  for (let x = 1; x < out.length; x++) {
    if (out[x].start_sec < out[x - 1].end_sec) {
      const mid = (out[x].start_sec + out[x - 1].end_sec) / 2;
      out[x - 1].end_sec = Math.max(out[x - 1].start_sec, mid);
      out[x].start_sec = Math.min(out[x].end_sec, mid);
    }
  }
  return out.map((s) => ({ ...s, start_sec: round3(s.start_sec), end_sec: round3(s.end_sec) }));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
