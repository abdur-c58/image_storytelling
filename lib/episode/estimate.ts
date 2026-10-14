import { DEFAULT_CARD_SECONDS, WORDS_PER_SECOND } from "./constants";
import type { Episode, Segment } from "./schema";

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function spokenText(segment: Pick<Segment, "narration" | "silent">): string {
  return segment.silent ? "" : segment.narration;
}

/** Rough duration of one segment before TTS exists (words / 2.4 wps, cards held for at least their minimum). */
export function estimateSegmentSeconds(segment: Segment, pauseMs: number): number {
  const words = countWords(spokenText(segment));
  const speech = words / WORDS_PER_SECOND;
  const isCard = segment.type === "title_card" || segment.type === "infographic";
  const minimum = segment.min_duration_sec ?? (isCard || segment.silent ? DEFAULT_CARD_SECONDS : 0);
  return Math.max(speech + (words > 0 ? pauseMs / 1000 : 0), minimum);
}

export interface EpisodeEstimate {
  total_seconds: number;
  total_words: number;
  segment_count: number;
  images_to_generate: number;
  cards: number;
  reused_images: number;
  sfx_cues: number;
  tts_characters: number;
}

type EstimateInput = Pick<Episode, "segments" | "thumbnail"> & {
  voice: Pick<Episode["voice"], "pause_between_segments_ms">;
  render: Pick<Episode["render"], "intro_sec" | "outro_sec">;
};

export function estimateEpisode(episode: EstimateInput): EpisodeEstimate {
  const pause = episode.voice.pause_between_segments_ms;
  let total = episode.render.intro_sec + episode.render.outro_sec;
  let words = 0;
  let images = 0;
  let cards = 0;
  let reused = 0;
  let sfx = 0;
  let ttsChars = 0;
  for (const segment of episode.segments) {
    total += estimateSegmentSeconds(segment, pause);
    words += countWords(spokenText(segment));
    sfx += segment.sfx.length;
    if (!segment.silent) ttsChars += (segment.tts_text ?? segment.narration).length;
    if (segment.type === "illustration") images += 1;
    if (segment.type === "reuse_image") reused += 1;
    if (segment.type === "title_card" || segment.type === "infographic") {
      cards += 1;
      if (segment.remotion?.props.background === "image" && segment.image?.prompt.trim()) images += 1;
    }
  }
  images += 1 + episode.thumbnail.alt_variants;
  return {
    total_seconds: Math.round(total),
    total_words: words,
    segment_count: episode.segments.length,
    images_to_generate: images,
    cards,
    reused_images: reused,
    sfx_cues: sfx,
    tts_characters: ttsChars,
  };
}
