import { mergeCropPolicy } from "@/lib/episode/resolve";
import type { CropPolicy, Episode } from "@/lib/episode/schema";
import { segmentSentences } from "@/lib/episode/sentences";
import { pictureSourceSegmentId } from "@/lib/episode/prompt";
import { planSegmentCrops, type CropKeyframe } from "./plan";
import { timeSentences, type SentenceTiming, type TimedWord } from "./sentences";

export interface TimelineSegment {
  id: string;
  type: string;
  start: number;
  end: number;
  voice_start: number | null;
  voice_duration: number | null;
  display: string | null;
  words: TimedWord[];
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

/** Add sentences, crop_plan and crop_seed to every segment of an aligned timeline. Pure. */
export function applyCropPlans(timeline: Timeline, episode: Episode, opts: CropOptions): Timeline {
  if (!episode.crop_policy) return timeline;
  const byId = new Map(episode.segments.map((s) => [s.id, s]));
  const segments = timeline.segments.map((tseg) => {
    const src = byId.get(tseg.id);
    if (!src) return tseg;
    const spoken = tseg.voice_start !== null && !src.silent && !!src.narration.trim();
    const sentences = spoken
      ? timeSentences(segmentSentences(src), tseg.words ?? [], tseg.voice_start!, tseg.voice_start! + (tseg.voice_duration ?? 0))
      : [];
    const isPicture = !!tseg.display && tseg.display.startsWith("image/");
    const setting = opts.settings[tseg.id] ?? { enabled: null, salt: 0 };
    const policy = segmentPolicy(episode, tseg.id, setting);
    const seed = cropSeed(episode, policy, opts.projectSeed, tseg.id, setting.salt);
    const sourceId = pictureSourceSegmentId(episode, src);
    const focal = (sourceId ? byId.get(sourceId)?.image?.focal_points : src.image?.focal_points) ?? [];
    const crop_plan = isPicture
      ? planSegmentCrops({
          sentences,
          segment_start: tseg.start,
          segment_end: tseg.end,
          policy,
          focal_points: focal,
          seed,
        })
      : [];
    return { ...tseg, sentences, crop_plan, crop_seed: isPicture ? seed : null };
  });
  return { ...timeline, version: 2, segments };
}
