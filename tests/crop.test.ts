import { describe, expect, it } from "vitest";
import { planSegmentCrops, rectAt, sampleAmount, transitionStart, windowScale, type CropKeyframe } from "@/lib/crop/plan";
import { seededRandom } from "@/lib/crop/random";
import { alignTokens, timeSentences, type SentenceTiming } from "@/lib/crop/sentences";
import { CROP_HARD_CAP } from "@/lib/episode/constants";
import { CropPolicySchema, type CropPolicy } from "@/lib/episode/schema";
import { splitSentences } from "@/lib/episode/sentences";

const policy = (over: Partial<CropPolicy> = {}): CropPolicy => CropPolicySchema.parse(over);

/** Random sentence timings: lengths 1.2–5 s, gaps 0–700 ms. */
function randomSentences(rng: () => number, n: number, start = 10): SentenceTiming[] {
  const out: SentenceTiming[] = [];
  let t = start + 0.1;
  for (let i = 0; i < n; i++) {
    const len = 1.2 + rng() * 3.8;
    out.push({ index: i, text: `Sentence ${i}.`, start_sec: t, end_sec: t + len });
    t += len + rng() * 0.7;
  }
  return out;
}

function check(plan: CropKeyframe[], s: SentenceTiming[], p: CropPolicy, segStart: number, segEnd: number) {
  let prevEnd = segStart;
  plan.forEach((k, i) => {
    expect(k.kind).toBe(i % 2 === 0 ? "crop" : "return");
    expect(k.at_sec).toBeGreaterThanOrEqual(segStart - 1e-3);
    expect(k.at_sec + k.duration_sec).toBeLessThanOrEqual(segEnd + 1e-3);
    expect(k.at_sec).toBeGreaterThanOrEqual(prevEnd - 2e-3);
    prevEnd = k.at_sec + k.duration_sec;
    const r = k.rect;
    expect(r.x).toBeGreaterThanOrEqual(-1e-9);
    expect(r.y).toBeGreaterThanOrEqual(-1e-9);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-4);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-4);
    if (k.kind === "crop") {
      expect(k.amount).toBeLessThanOrEqual(Math.min(p.max_crop, CROP_HARD_CAP) + 1e-9);
      expect(k.amount).toBeGreaterThanOrEqual(p.min_crop - 1e-9);
      expect(r.w).toBeCloseTo(windowScale(k.amount, p.crop_measure), 4);
      expect(k.sentence_index).toBeGreaterThanOrEqual(1);
    } else {
      expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    }
  });
  // Holds respect min_hold_sec.
  for (let i = 0; i + 1 < plan.length; i++) {
    expect(plan[i + 1].at_sec - (plan[i].at_sec + plan[i].duration_sec)).toBeGreaterThanOrEqual(p.min_hold_sec - 1e-3);
  }
  if (s.length < 2) expect(plan).toEqual([]);
}

describe("crop engine (property tests)", () => {
  it("never exceeds the hard cap, stays in frame, alternates crop/return and respects holds", () => {
    const rng = seededRandom("props");
    for (let run = 0; run < 600; run++) {
      const n = 1 + Math.floor(rng() * 8);
      const s = randomSentences(rng, n);
      const p = policy({
        crop_measure: rng() < 0.5 ? "linear" : "area",
        transition: rng() < 0.2 ? "cut" : "ease",
        min_hold_sec: rng() * 2,
        hold_sentences: 1 + Math.floor(rng() * 2),
        end_on_full_frame: rng() < 0.3,
      });
      const segStart = 10;
      const segEnd = s[s.length - 1].end_sec + 0.45;
      const focal = rng() < 0.5 ? [{ label: "door", x: rng(), y: rng() }] : [];
      const plan = planSegmentCrops({ sentences: s, segment_start: segStart, segment_end: segEnd, policy: p, focal_points: focal, seed: `r${run}` });
      check(plan, s, p, segStart, segEnd);
    }
  });

  it("one-sentence segments never crop; two-sentence segments crop on sentence 2", () => {
    const rng = seededRandom("two");
    for (let run = 0; run < 200; run++) {
      const one = randomSentences(rng, 1);
      expect(planSegmentCrops({ sentences: one, segment_start: 10, segment_end: 30, policy: policy(), focal_points: [], seed: `a${run}` })).toEqual([]);
      const two = randomSentences(rng, 2);
      const plan = planSegmentCrops({ sentences: two, segment_start: 10, segment_end: two[1].end_sec + 0.4, policy: policy({ min_hold_sec: 0.5 }), focal_points: [], seed: `b${run}` });
      if (two[1].start_sec - 10 >= 1) {
        expect(plan.length).toBe(1);
        expect(plan[0].sentence_index).toBe(1);
      }
    }
  });

  it("draws about 85% of crops from the typical range", () => {
    const rng = seededRandom("amounts");
    const p = policy();
    let typical = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const c = sampleAmount(rng, p);
      expect(c).toBeGreaterThanOrEqual(0.04);
      expect(c).toBeLessThanOrEqual(0.2);
      if (c <= 0.1) typical++;
    }
    expect(typical / N).toBeGreaterThan(0.83);
    expect(typical / N).toBeLessThan(0.87);
  });

  it("samples N between 2 and 1 at roughly 80/20 for longer segments", () => {
    let onFirst = 0;
    let total = 0;
    const rng = seededRandom("n");
    for (let run = 0; run < 3000; run++) {
      const s = randomSentences(rng, 4).map((x, i) => ({ ...x, start_sec: 10 + i * 4 + 0.5, end_sec: 10 + i * 4 + 3.5 }));
      const plan = planSegmentCrops({ sentences: s, segment_start: 10, segment_end: 26, policy: policy({ min_hold_sec: 0 }), focal_points: [], seed: `n${run}` });
      if (!plan.length) continue;
      total++;
      if (plan[0].sentence_index === 1) onFirst++;
    }
    expect(onFirst / total).toBeGreaterThan(0.16);
    expect(onFirst / total).toBeLessThan(0.24);
  });

  it("is deterministic per seed and changes with the seed", () => {
    const s = randomSentences(seededRandom("d"), 6);
    const args = { sentences: s, segment_start: 10, segment_end: s[5].end_sec + 0.4, policy: policy({ min_hold_sec: 0.5 }), focal_points: [] };
    const a = planSegmentCrops({ ...args, seed: "x:seg_1:0" });
    expect(planSegmentCrops({ ...args, seed: "x:seg_1:0" })).toEqual(a);
    const others = [1, 2, 3, 4].map((salt) => JSON.stringify(planSegmentCrops({ ...args, seed: `x:seg_1:${salt}` })));
    expect(others.some((o) => o !== JSON.stringify(a))).toBe(true);
  });

  it("area measure keeps 1 - c of the area", () => {
    expect(windowScale(0.19, "area") ** 2).toBeCloseTo(0.81, 10);
    expect(windowScale(0.1, "linear")).toBeCloseTo(0.9, 10);
  });

  it("places transitions in sentence gaps", () => {
    const a: SentenceTiming = { index: 0, text: "", start_sec: 0, end_sec: 2 };
    expect(transitionStart(a, { index: 1, text: "", start_sec: 2.6, end_sec: 4 }, 0.4)).toBeCloseTo(2.1, 6); // centred
    expect(transitionStart(a, { index: 1, text: "", start_sec: 2.1, end_sec: 4 }, 0.4)).toBeCloseTo(1.7, 6); // finishes on the word
  });

  it("rectAt interpolates and returns to full frame", () => {
    const plan: CropKeyframe[] = [
      { kind: "crop", at_sec: 1, duration_sec: 1, easing: "linear", rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, amount: 0.2, sentence_index: 1, focal_label: null },
      { kind: "return", at_sec: 4, duration_sec: 0, easing: "linear", rect: { x: 0, y: 0, w: 1, h: 1 }, amount: 0, sentence_index: 2, focal_label: null },
    ];
    expect(rectAt(plan, 0.5)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(rectAt(plan, 1.5, (x) => x).w).toBeCloseTo(0.9, 6);
    expect(rectAt(plan, 3).w).toBeCloseTo(0.8, 6);
    expect(rectAt(plan, 4.1)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("sentences", () => {
  it("splits on terminators but not abbreviations, decimals or mid-sentence ellipses", () => {
    expect(splitSentences("Mr. Hale counted 3.5 cans. Then he stopped... and listened. Nothing! Was it over?")).toEqual([
      "Mr. Hale counted 3.5 cans.",
      "Then he stopped... and listened.",
      "Nothing!",
      "Was it over?",
    ]);
    expect(splitSentences('"Run," she said. "Now!" He ran.')).toEqual(['"Run," she said.', '"Now!"', "He ran."]);
    expect(splitSentences("It waited... Nothing came.")).toEqual(["It waited...", "Nothing came."]);
  });

  it("maps sentences onto Whisper words, tolerating misheard words", () => {
    const words = [
      { word: "The", start: 0, end: 0.2 },
      { word: "door", start: 0.2, end: 0.5 },
      { word: "opened.", start: 0.5, end: 1 },
      { word: "Nobody", start: 1.6, end: 2 },
      { word: "cane", start: 2, end: 2.3 },
      { word: "in.", start: 2.3, end: 2.6 },
    ];
    const t = timeSentences(["The door opened.", "Nobody came in."], words, 0, 3);
    expect(t[0]).toMatchObject({ start_sec: 0, end_sec: 1 });
    expect(t[1]).toMatchObject({ start_sec: 1.6, end_sec: 2.6 });
    expect(alignTokens(["a", "b", "c"], ["a", "c"])).toEqual([0, -1, 1]);
  });

  it("falls back to proportional timing without words", () => {
    const t = timeSentences(["One two.", "Three four five six."], [], 10, 16);
    expect(t[0].start_sec).toBe(10);
    expect(t[0].end_sec).toBeCloseTo(12, 3);
    expect(t[1].end_sec).toBeCloseTo(16, 3);
  });
});
