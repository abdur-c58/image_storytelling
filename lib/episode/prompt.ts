import type { Episode, Segment } from "./schema";

export interface ImageItem {
  /** Segment id, or "thumbnail" for thumbnail bases. */
  segment_id: string;
  /** Stable asset key inside the project, e.g. "image/seg_004" or "thumbnail_base/0". */
  asset_key: string;
  final_prompt: string;
  negative_prompt: string;
  reference_image_ids: string[];
  reference_image_urls: string[];
  aspect_ratio: string;
  output_filename: string;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function characterLines(episode: Episode, ids: string[]): string[] {
  const byId = new Map(episode.style_bible.characters.map((c) => [c.id, c]));
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => sentence(`${c.name}: ${c.visual_description}`));
}

function referenceIds(episode: Episode, characterIds: string[]): string[] {
  const byId = new Map(episode.style_bible.characters.map((c) => [c.id, c]));
  const ids = new Set<string>();
  for (const cid of characterIds) for (const rid of byId.get(cid)?.reference_image_ids ?? []) ids.add(rid);
  return [...ids];
}

function referenceUrls(episode: Episode, ids: string[]): string[] {
  const byId = new Map(episode.style_bible.reference_assets.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id)?.asset_url_or_path ?? "")
    .filter((url) => /^https?:\/\//i.test(url));
}

/**
 * final_prompt = global style + character descriptions + shot/mood/time + scene.
 * Kept on one line: the bot pastes it into a single text box, where a newline may submit.
 */
export function assemblePrompt(
  episode: Episode,
  scene: string,
  characters: string[],
  extras: { shot_type?: string; mood?: string; time_of_day?: string } = {},
): string {
  const parts = [
    sentence(episode.style_bible.global_style_prompt),
    ...characterLines(episode, characters),
    extras.shot_type ? sentence(`Shot: ${extras.shot_type}`) : "",
    extras.mood ? sentence(`Mood: ${extras.mood}`) : "",
    extras.time_of_day ? sentence(`Time of day: ${extras.time_of_day}`) : "",
    sentence(`Scene: ${scene}`),
  ];
  return parts.filter(Boolean).join(" ");
}

export function assembleNegative(episode: Episode, extra = ""): string {
  return [episode.style_bible.negative_prompt, extra]
    .map((p) => p.trim().replace(/[,\s]+$/, ""))
    .filter(Boolean)
    .join(", ");
}

function outputName(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? key);
}

export function segmentNeedsGeneratedImage(segment: Segment): boolean {
  if (segment.type === "illustration") return true;
  if (segment.type === "title_card" || segment.type === "infographic") {
    return segment.remotion?.props.background === "image" && !segment.remotion.props.background_image_segment_id && !!segment.image?.prompt.trim();
  }
  return false;
}

export function buildSegmentImageItem(episode: Episode, segment: Segment): ImageItem {
  const image = segment.image!;
  const trigger = episode.automation.bot_triggers.find((t) => t.trigger_id === "generate_images");
  const refIds = referenceIds(episode, image.characters_present);
  return {
    segment_id: segment.id,
    asset_key: `image/${segment.id}`,
    final_prompt: assemblePrompt(episode, image.prompt, image.characters_present, image),
    negative_prompt: assembleNegative(episode, image.negative_prompt_extra),
    reference_image_ids: refIds,
    reference_image_urls: referenceUrls(episode, refIds),
    aspect_ratio: episode.style_bible.aspect_ratio,
    output_filename: outputName(trigger?.output_naming ?? "{segment_id}.png", { segment_id: segment.id }),
  };
}

export function buildImageItems(episode: Episode): ImageItem[] {
  return [...episode.segments]
    .sort((a, b) => a.order - b.order)
    .filter(segmentNeedsGeneratedImage)
    .map((segment) => buildSegmentImageItem(episode, segment));
}

export function buildThumbnailItems(episode: Episode): ImageItem[] {
  const trigger = episode.automation.bot_triggers.find((t) => t.trigger_id === "generate_thumbnail_base");
  const refIds = referenceIds(episode, episode.thumbnail.characters_present);
  const items: ImageItem[] = [];
  for (let variant = 0; variant <= episode.thumbnail.alt_variants; variant++) {
    items.push({
      segment_id: "thumbnail",
      asset_key: `thumbnail_base/${variant}`,
      final_prompt: assemblePrompt(episode, episode.thumbnail.image_prompt, episode.thumbnail.characters_present),
      negative_prompt: assembleNegative(episode, "text, letters, watermark"),
      reference_image_ids: refIds,
      reference_image_urls: referenceUrls(episode, refIds),
      aspect_ratio: "16:9",
      output_filename: outputName(trigger?.output_naming ?? "thumbnail_base_{variant}.png", { variant: String(variant) }),
    });
  }
  return items;
}

/** Segment whose generated picture a segment displays (follows reuse chains). */
export function pictureSourceSegmentId(episode: Episode, segment: Segment): string | null {
  const byId = new Map(episode.segments.map((s) => [s.id, s]));
  let current: Segment | undefined = segment;
  for (let hops = 0; current && hops < episode.segments.length; hops++) {
    if (current.type === "reuse_image") {
      current = byId.get(current.image?.reuse_from_segment_id ?? "");
      continue;
    }
    if (current.type === "title_card" || current.type === "infographic") {
      const bg = current.remotion?.props.background_image_segment_id;
      if (current.remotion?.props.background !== "image") return null;
      if (bg) {
        current = byId.get(bg);
        continue;
      }
    }
    return current.id;
  }
  return null;
}
