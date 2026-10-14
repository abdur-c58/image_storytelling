import { POSITION_POINTS } from "@/lib/episode/constants";
import { mergeCropPolicy } from "@/lib/episode/resolve";
import type { CropPolicy, Episode, Segment } from "@/lib/episode/schema";
import { segmentSentenceUnits, type SentenceUnit } from "@/lib/episode/sentences";
import { pictureSourceSegmentId } from "@/lib/episode/prompt";
import { planSegmentCrops, type CropKeyframe, type FocalPoint } from "./plan";
import { timeSentences, type SentenceTiming, type TimedWord } from "./sentences";

/** Where a line sits inside its segment's voice file (seconds from the start of that file). */
export interface LineTiming {
  line_id: string;
  speaker: string;
  start: number;
  end: number;
  voice_effect?: string;
}

export interface TimelineSegment {
  id: string;
  type: string;
  start: number;
  end: number;
  voice_start: number | null;
  voice_duration: number | null;
  display: string | null;
  words: TimedWord[];
  lines?: LineTiming[];
  sentences?: SentenceTiming[];
  crop_plan?: CropKeyframe[];
  crop_seed?: string | null;
  [key: string]: unknown;
}

export interface Timeline {
  segments: TimelineSegment[];
  [key: string]: unknown;
}

export interface SegmentCropSetting {
  /** null follows the policy; false turns crops off for this segment; true forces them on. */
  enabled: boolean | null;
  /** Bumped by "re-roll" to draw a different plan. */
  salt: number;
}

export interface CropOptions {
  projectSeed: string;
  settings: Record<string, SegmentCropSetting>;
  /** Line windows reported by the voice stage, by segment id. */
  lineTimings?: Record<string, LineTiming[]>;
}

export function segmentPolicy(episode: Episode, segmentId: string, setting?: SegmentCropSetting): CropPolicy {
  const seg = episode.segments.find((s) => s.id === segmentId);
  const policy = mergeCropPolicy(episode.crop_policy, seg?.image?.crop_override as Record<string, unknown> | null | undefined);
  if (setting && setting.enabled !== null) return { ...policy, enabled: setting.enabled };
  return policy;
}

export function cropSeed(episode: Episode, policy: CropPolicy, projectSeed: string, segmentId: string, salt: number): string {
  const base = policy.seed_mode === "fixed" ? `fixed:${policy.seed ?? 0}` : projectSeed;
  return `${base}:${segmentId}:${salt}`;
}

const tag = (t: SentenceTiming, u: SentenceUnit): SentenceTiming => ({ ...t, line_id: u.line_id, speaker: u.speaker, on_screen: u.on_screen });

/**
 * Sentence times across all lines. With line windows (from the voice stage) each line's sentences are timed
 * inside its own window from the words heard there; otherwise the whole segment is aligned at once.
 */
export function timeSegmentSentences(
  units: SentenceUnit[],
  words: TimedWord[],
  voiceStart: number,
  voiceEnd: number,
  lines: LineTiming[] | undefined,
): SentenceTiming[] {
  const byLine = new Map((lines ?? []).map((l) => [l.line_id, l]));
  const usable = units.length > 0 && units.every((u) => byLine.has(u.line_id));
  if (!usable) {
    return timeSentences(units.map((u) => u.text), words, voiceStart, voiceEnd).map((t, i) => tag(t, units[i]));
  }
  const out: SentenceTiming[] = [];
  let index = 0;
  for (const lineId of [...new Set(units.map((u) => u.line_id))]) {
    const lu = units.filter((u) => u.line_id === lineId);
    const w = byLine.get(lineId)!;
    const a = voiceStart + w.start;
    const b = voiceStart + w.end;
    const heard = words.filter((x) => x.start >= a - 0.05 && x.start < b + 0.05);
    for (const t of timeSentences(lu.map((u) => u.text), heard, a, b)) out.push({ ...tag(t, lu[t.index]), index: index++ });
  }
  return out;
}

/** Where to aim a crop on each on-screen speaker: their focal point, else their coarse frame position. */
export function speakerFocals(seg: Segment, focal: FocalPoint[]): Record<string, FocalPoint> {
  const out: Record<string, FocalPoint> = {};
  for (const cp of seg.scene?.characters_present ?? []) {
    const own = focal.find((f) => f.label === cp.character_id);
    const pos = POSITION_POINTS[cp.position_in_frame] ?? POSITION_POINTS.center;
    out[cp.character_id] = own ?? { label: cp.character_id, x: pos.x, y: pos.y };
  }
  for (const f of focal) if (f.label && !out[f.label]) out[f.label] = f;
  return out;
}

/** Add sentences, crop_plan and crop_seed to every segment of an aligned timeline. Pure. */
export function applyCropPlans(timeline: Timeline, episode: Episode, opts: CropOptions): Timeline {
  if (!episode.crop_policy) return timeline;
  const byId = new Map(episode.segments.map((s) => [s.id, s]));
  const segments = timeline.segments.map((tseg) => {
    const src = byId.get(tseg.id);
    if (!src) return tseg;
    const units = segmentSentenceUnits(src);
    const spoken = tseg.voice_start !== null && units.length > 0;
    const lines = opts.lineTimings?.[tseg.id] ?? tseg.lines;
    const sentences = spoken
      ? timeSegmentSentences(units, tseg.words ?? [], tseg.voice_start!, tseg.voice_start! + (tseg.voice_duration ?? 0), lines)
      : [];
    const isPicture = !!tseg.display && tseg.display.startsWith("image/");
    const setting = opts.settings[tseg.id] ?? { enabled: null, salt: 0 };
    const policy = segmentPolicy(episode, tseg.id, setting);
    const seed = cropSeed(episode, policy, opts.projectSeed, tseg.id, setting.salt);
    const sourceId = pictureSourceSegmentId(episode, src);
    const source = sourceId ? byId.get(sourceId) : src;
    const focal = source?.image?.focal_points ?? [];
    const crop_plan = isPicture
      ? planSegmentCrops({
          sentences,
          segment_start: tseg.start,
          segment_end: tseg.end,
          policy,
          focal_points: focal,
          speaker_focal: source ? speakerFocals(source, focal) : {},
          seed,
        })
      : [];
    return { ...tseg, ...(lines ? { lines } : {}), sentences, crop_plan, crop_seed: isPicture ? seed : null };
  });
  return { ...timeline, version: 2, segments };
}
