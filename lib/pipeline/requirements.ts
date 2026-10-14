import { segmentText } from "@/lib/episode/lines";
import { pictureSourceSegmentId, segmentNeedsGeneratedImage } from "@/lib/episode/prompt";
import type { Episode, Segment } from "@/lib/episode/schema";

export function orderedSegments(ep: Episode): Segment[] {
  return [...ep.segments].sort((a, b) => a.order - b.order);
}

export function isCard(segment: Segment): boolean {
  return segment.type === "title_card" || segment.type === "infographic";
}

export function isSpoken(segment: Segment): boolean {
  return segmentText(segment).trim().length > 0;
}

export const assetKeys = {
  image: (segmentId: string) => `image/${segmentId}`,
  voice: (segmentId: string) => `voice/${segmentId}`,
  card: (segmentId: string) => `card/${segmentId}`,
  sfx: (cueId: string) => `sfx/${cueId}`,
  thumbnailBase: (variant: number) => `thumbnail_base/${variant}`,
  thumbnail: (variant: number) => `thumbnail/${variant}`,
  timeline: "timeline/main",
  mixAudio: "mix/audio",
  mixReport: "mix/report",
  captions: "captions/srt",
  video: "video/final",
  preview: "video/preview",
} as const;

export interface Requirements {
  spoken: string[];
  images: string[];
  cards: string[];
  /** card segment id -> segment whose generated image is its background */
  cardBackgrounds: Record<string, string>;
  thumbnailVariants: number[];
  cues: { cue_id: string; segment_id: string }[];
}

export function requirements(ep: Episode): Requirements {
  const segs = orderedSegments(ep);
  const cardBackgrounds: Record<string, string> = {};
  for (const seg of segs) {
    if (isCard(seg) && seg.remotion?.props.background === "image") {
      const source = pictureSourceSegmentId(ep, seg);
      if (source) cardBackgrounds[seg.id] = source;
    }
  }
  return {
    spoken: segs.filter(isSpoken).map((s) => s.id),
    images: segs.filter(segmentNeedsGeneratedImage).map((s) => s.id),
    cards: segs.filter(isCard).map((s) => s.id),
    cardBackgrounds,
    thumbnailVariants: Array.from({ length: ep.thumbnail.alt_variants + 1 }, (_, i) => i),
    cues: segs.flatMap((s) => s.sfx.map((c) => ({ cue_id: c.id, segment_id: s.id }))),
  };
}

/** Which image asset a segment displays in the final video (cards use their rendered card). */
export function displayAssetKey(ep: Episode, segment: Segment): string | null {
  if (isCard(segment)) return assetKeys.card(segment.id);
  const source = pictureSourceSegmentId(ep, segment);
  return source ? assetKeys.image(source) : null;
}

/** Downstream stages that must re-run when a stage's output changes. */
export const INVALIDATES: Record<string, string[]> = {
  generate_images: ["render", "upload_youtube"],
  thumbnail_base: ["thumbnail_compose", "upload_youtube"],
  voice: ["align", "mix", "render", "upload_youtube"],
  align: ["mix", "render", "upload_youtube"],
  sfx: ["mix", "render", "upload_youtube"],
  cards: ["render", "upload_youtube"],
  thumbnail_compose: ["upload_youtube"],
  mix: ["render", "upload_youtube"],
  render: ["upload_youtube"],
};
