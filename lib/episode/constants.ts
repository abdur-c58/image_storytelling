export const SCHEMA_VERSION = "1.0";

export const SEGMENT_TYPES = ["illustration", "title_card", "infographic", "reuse_image"] as const;
export const REMOTION_TEMPLATES = [
  "title_card",
  "supplies_card",
  "pictogram_chart",
  "statement_card",
  "lower_third",
  "custom",
] as const;
export const SFX_PLACEMENTS = ["segment_start", "segment_end", "at_phrase", "whole_segment"] as const;
export const MOTIONS = ["none", "slow_zoom_in", "slow_zoom_out", "pan_left", "pan_right"] as const;
export const TRANSITIONS = ["cut", "crossfade_150ms", "fade_black"] as const;
export const CARD_BACKGROUNDS = ["dark", "cream", "image"] as const;
export const SHOT_TYPES = ["wide", "medium", "close-up", "top-down", "over-the-shoulder"] as const;
export const VISIBILITIES = ["private", "unlisted", "public", "scheduled"] as const;
export const THUMBNAIL_TEXT_STYLES = [
  "impact_white_black_outline",
  "impact_yellow_black_outline",
  "red_badge",
  "plain_white",
] as const;
export const THUMBNAIL_POSITIONS = [
  "top_left",
  "top_center",
  "top_right",
  "left_middle",
  "center",
  "right_middle",
  "bottom_left",
  "bottom_center",
  "bottom_right",
] as const;
export const PIPELINE_FIRE_STATES = ["VALIDATED", "IMAGES_RECEIVED", "RENDER_COMPLETE"] as const;
export const BOT_TASK_TYPES = ["generate_images", "upload_youtube"] as const;

/** YouTube category name -> category id (YouTube Data API v3, region-independent ids). */
export const YOUTUBE_CATEGORIES: Record<string, number> = {
  "Film & Animation": 1,
  "Autos & Vehicles": 2,
  Music: 10,
  "Pets & Animals": 15,
  Sports: 17,
  "Travel & Events": 19,
  Gaming: 20,
  "People & Blogs": 22,
  Comedy: 23,
  Entertainment: 24,
  "News & Politics": 25,
  "Howto & Style": 26,
  Education: 27,
  "Science & Technology": 28,
  "Nonprofits & Activism": 29,
};

/** Icon names shipped in story-telling-worker/remotion/src/icons. Unknown names render a generic circle + label (warning). */
export const KNOWN_ICONS = [
  "water_jug",
  "can",
  "gas_canister",
  "zombie_head",
  "radio",
  "pigeon",
  "kite",
  "person",
  "medkit",
  "battery",
  "flashlight",
  "fire",
  "rope",
  "key",
  "door",
  "knife",
  "bread",
  "bottle",
  "tent",
  "sun",
  "moon",
  "skull",
  "heart",
  "house",
] as const;

export const WORDS_PER_SECOND = 2.4;
export const DEFAULT_CARD_SECONDS = 2.5;
export const MAX_SEGMENT_WORDS_WARNING = 60;
export const MIN_RUNTIME_WARNING_SEC = 5 * 60;
export const MAX_RUNTIME_WARNING_SEC = 20 * 60;

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;
