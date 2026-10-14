import { CROP_HARD_CAP } from "@/lib/episode/constants";
import type { CropPolicy } from "@/lib/episode/schema";
import { seededRandom } from "./random";
import type { SentenceTiming } from "./sentences";

/** Normalised window (0–1) of the source image, top-left origin. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropKeyframe {
  kind: "crop" | "return";
  /** Timeline seconds when the transition starts. */
  at_sec: number;
  duration_sec: number;
  easing: string;
  /** Window at the end of the transition (full frame for "return"). */
  rect: CropRect;
  /** Crop amount c (0 for "return"). */
  amount: number;
  /** Sentence the camera settles on. */
  sentence_index: number;
  focal_label: string | null;
}

export interface FocalPoint {
  label: string;
  x: number;
  y: number;
}

export const FULL_FRAME: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** Gaps at least this long get a centred transition; shorter ones finish on the next sentence's first word. */
export const CENTRE_GAP_SEC = 0.3;

export interface PlanInput {
  sentences: SentenceTiming[];
  /** Where the picture is on screen. */
  segment_start: number;
  segment_end: number;
  policy: CropPolicy;
  focal_points: FocalPoint[];
  /** Point to aim at when an on-screen speaker's sentence triggers a crop, by speaker id. */
  speaker_focal?: Record<string, FocalPoint>;
  seed: string;
}

/** A speaker change between sentence k-1 and k (only when sentences carry speakers). */
export function isSpeakerBoundary(s: SentenceTiming[], k: number): boolean {
  return k > 0 && k < s.length && !!s[k].speaker && !!s[k - 1].speaker && s[k].speaker !== s[k - 1].speaker;
}

/** Move a crop start by up to one sentence onto a speaker change, staying after `first`. */
export function snapToSpeakerBoundary(s: SentenceTiming[], c: number, first: number): number {
  if (isSpeakerBoundary(s, c)) return c;
  if (c + 1 < s.length && isSpeakerBoundary(s, c + 1)) return c + 1;
  if (c - 1 > first && isSpeakerBoundary(s, c - 1)) return c - 1;
  return c;
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;

/** Window side as a fraction of the frame for crop amount c. */
export function windowScale(c: number, measure: CropPolicy["crop_measure"]): number {
  return measure === "area" ? Math.sqrt(1 - c) : 1 - c;
}

export function sampleAmount(rng: () => number, p: CropPolicy): number {
  const cap = Math.min(p.max_crop, CROP_HARD_CAP);
  const lo = Math.min(p.min_crop, cap);
  const typ = Math.min(Math.max(p.typical_max_crop, lo), cap);
  const c = rng() < p.prob_typical || typ >= cap ? lo + rng() * (typ - lo) : cap - rng() * (cap - typ);
  return Math.min(cap, Math.max(0, c));
}

export function sampleN(rng: () => number, weights: Record<string, number>): number {
  const entries = Object.entries(weights)
    .map(([k, w]) => [Number(k), w] as const)
    .filter(([k, w]) => k >= 1 && w > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!entries.length || total <= 0) return 2;
  let u = rng() * total;
  for (const [k, w] of entries) {
    u -= w;
    if (u < 0) return k;
  }
  return entries[entries.length - 1][0];
}

/** Transition start between two sentences: centred in gaps ≥ 300 ms, else finishing at the next first word. */
export function transitionStart(prev: SentenceTiming, next: SentenceTiming, duration: number): number {
  const gap = next.start_sec - prev.end_sec;
  if (gap >= CENTRE_GAP_SEC) return prev.end_sec + gap / 2 - duration / 2;
  return next.start_sec - duration;
}

function pickWindow(
  rng: () => number,
  scale: number,
  p: CropPolicy,
  focal: FocalPoint[],
  previous: { x: number; y: number }[],
  speaker?: FocalPoint,
): { rect: CropRect; label: string | null } {
  const half = scale / 2;
  const clamp = (v: number) => Math.min(1 - half, Math.max(half, v));
  const range = 1 - scale;
  const minDist = range * 0.5;
  if (speaker && rng() < p.focal_bias) {
    const cx = clamp(speaker.x);
    const cy = clamp(speaker.y);
    return { rect: { x: r5(cx - half), y: r5(cy - half), w: r5(scale), h: r5(scale) }, label: speaker.label || null };
  }
  let best: { cx: number; cy: number; label: string | null; d: number } | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    let cx: number;
    let cy: number;
    let label: string | null = null;
    if (focal.length && rng() < p.focal_bias) {
      const f = focal[Math.floor(rng() * focal.length)];
      cx = clamp(f.x);
      cy = clamp(f.y);
      label = f.label || null;
    } else {
      cx = half + rng() * range;
      cy = half + rng() * range;
    }
    const d = previous.length ? Math.min(...previous.map((q) => Math.hypot(q.x - cx, q.y - cy))) : Infinity;
    if (!best || d > best.d) best = { cx, cy, label, d };
    if (!p.avoid_repeat_region || d >= minDist) break;
  }
  const { cx, cy, label } = best!;
  return { rect: { x: r5(cx - half), y: r5(cy - half), w: r5(scale), h: r5(scale) }, label };
}

/**
 * Sentence-driven crop plan for one picture. Starts on the full frame; after N full-frame sentences
 * (N drawn from sentences_before_crop; always 1 for two-sentence segments) it crops for hold_sentences
 * sentences, then returns to the full frame before the next crop. One-sentence segments never crop.
 */
export function planSegmentCrops(input: PlanInput): CropKeyframe[] {
  const { sentences: s, policy: p } = input;
  const n = s.length;
  if (!p.enabled || n < 2) return [];
  const rng = seededRandom(input.seed);
  const dur = p.transition === "cut" ? 0 : p.transition_ms / 1000;
  const scale = (c: number) => windowScale(c, p.crop_measure);
  const out: CropKeyframe[] = [];
  const centres: { x: number; y: number }[] = [];
  const clampT = (t: number) => Math.min(input.segment_end - dur, Math.max(input.segment_start, t));

  let first = 0;
  let fullSince = input.segment_start;
  while (first < n) {
    const N = n === 2 ? 1 : sampleN(rng, p.sentences_before_crop);
    const c = n === 2 ? first + N : snapToSpeakerBoundary(s, first + N, first);
    if (c >= n) break;
    const tIn = clampT(transitionStart(s[c - 1], s[c], dur));
    if (tIn - fullSince < p.min_hold_sec) {
      first = c;
      continue;
    }
    let last = Math.min(n - 1, c + p.hold_sentences - 1);
    // Return to full frame on a speaker change if one is a sentence away.
    if (last + 2 < n && !isSpeakerBoundary(s, last + 1) && isSpeakerBoundary(s, last + 2)) last++;
    let tOut: number | null = null;
    for (;;) {
      if (last < n - 1) tOut = clampT(transitionStart(s[last], s[last + 1], dur));
      else tOut = p.end_on_full_frame ? clampT(Math.min(s[last].end_sec, input.segment_end - dur)) : null;
      const holdEnd = tOut ?? input.segment_end;
      if (holdEnd - (tIn + dur) >= p.min_hold_sec || last >= n - 1) break;
      last++;
    }
    const holdEnd = tOut ?? input.segment_end;
    if (holdEnd - (tIn + dur) < p.min_hold_sec) break;

    const amount = sampleAmount(rng, p);
    const trigger = s[c];
    const speakerPoint = trigger.on_screen && trigger.speaker ? input.speaker_focal?.[trigger.speaker] : undefined;
    const win = pickWindow(rng, scale(amount), p, input.focal_points, centres, speakerPoint);
    centres.push({ x: win.rect.x + win.rect.w / 2, y: win.rect.y + win.rect.h / 2 });
    out.push({
      kind: "crop",
      at_sec: r3(tIn),
      duration_sec: r3(dur),
      easing: p.easing,
      rect: win.rect,
      amount: r5(amount),
      sentence_index: c,
      focal_label: win.label,
    });
    if (tOut === null) break;
    out.push({
      kind: "return",
      at_sec: r3(tOut),
      duration_sec: r3(dur),
      easing: p.easing,
      rect: { ...FULL_FRAME },
      amount: 0,
      sentence_index: Math.min(n - 1, last + 1),
      focal_label: null,
    });
    fullSince = tOut + dur;
    first = last + 1;
  }
  return out;
}

/** Window shown at time t (for previews and tests); mirrors the worker's renderer. */
export function rectAt(plan: CropKeyframe[], t: number, ease: (x: number) => number = easeInOutCubic): CropRect {
  let from = FULL_FRAME;
  for (const k of plan) {
    if (t < k.at_sec) return from;
    if (k.duration_sec <= 0 || t >= k.at_sec + k.duration_sec) {
      from = k.rect;
      continue;
    }
    const u = ease((t - k.at_sec) / k.duration_sec);
    return {
      x: from.x + (k.rect.x - from.x) * u,
      y: from.y + (k.rect.y - from.y) * u,
      w: from.w + (k.rect.w - from.w) * u,
      h: from.h + (k.rect.h - from.h) * u,
    };
  }
  return from;
}

export const EASING_FUNCTIONS: Record<string, (x: number) => number> = {
  linear: (x) => x,
  easeInOutCubic,
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
};

export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
