export const SCHEMA_VERSION = "2.1";
/** 2.1 only adds optional fields, so 2.0 documents are still accepted. */
export const SUPPORTED_SCHEMA_VERSIONS = ["2.0", "2.1"] as const;
export const DOC_TYPES = ["story_bible", "episode", "bundle"] as const;

export const POV_MODES = ["second_person", "first_person", "third_person"] as const;
export const CHARACTER_SCOPES = ["story", "channel"] as const;
export const VOICE_EFFECTS = ["none", "radio", "phone", "muffled", "echo", "memory"] as const;
/** Effects that mean the speaker is not in the room (a remote voice). */
export const REMOTE_VOICE_EFFECTS = ["radio", "phone"] as const;
export const LINE_SOURCES = ["spoken", "written"] as const;
export const NARRATOR = "narrator";
export const CHARACTER_STATUSES = ["with_protagonist", "separated", "missing", "captive", "returned", "unknown", "deceased"] as const;
/** Statuses in which a character cannot be seen or heard in the present. */
export const ABSENT_STATUSES = ["separated", "missing", "captive", "deceased"] as const;
export const TIMEFRAMES = ["present", "flashback", "imagined"] as const;
export const VISUAL_TREATMENTS = ["flashback_tint", "none"] as const;
export const PAIRING_LAYOUTS = ["side_by_side", "foreground_background", "split"] as const;
/** Coarse frame positions used when a speaker has no focal point of their own. */
export const POSITION_POINTS: Record<string, { x: number; y: number }> = {
  left: { x: 0.3, y: 0.45 },
  center: { x: 0.5, y: 0.45 },
  right: { x: 0.7, y: 0.45 },
  background: { x: 0.5, y: 0.45 },
};
export const DEFAULT_MULTI_CHARACTER_NEGATIVE = "merged faces, duplicate faces, fused bodies, extra limbs, the same face on two people, twins";
export const DEFAULT_FLASHBACK_TREATMENT = "shown as a memory: faded warm sepia tint, soft hazy edges, gentle vignette";
export const PRONOUN_NAMES = ["you", "your", "yourself", "i", "me", "myself"] as const;

export const SEGMENT_TYPES = ["illustration", "title_card", "infographic", "reuse_image"] as const;
export const CHARACTER_ROLES = ["protagonist", "ally", "antagonist", "cameo", "extra"] as const;
export const FRAME_POSITIONS = ["left", "center", "right", "background"] as const;
export const WORLD_VARIABLE_TYPES = ["integer", "number", "string", "enum"] as const;
export const CROP_MEASURES = ["linear", "area"] as const;
export const CROP_TRANSITIONS = ["ease", "cut"] as const;
export const EASINGS = ["linear", "easeInOutCubic", "easeInOutSine", "easeOutCubic"] as const;
export const TAG_FALLBACK_MODES = ["split_and_silence", "none"] as const;

/**
 * Fish Audio Drama 3 (docs checked 2026-10-14): square-bracket cues are free-form directions; these are the
 * documented sounds and pauses. Word-scoped delivery uses the paired angle tags below.
 */
export const DEFAULT_TAG_WHITELIST = [
  "short pause",
  "pause",
  "long pause",
  "break",
  "long-break",
  "breath",
  "sigh",
  "laugh",
  "shaky breath",
] as const;
export const DEFAULT_PAIRED_TAGS = ["whisper", "emphasis", "soft", "fast", "slow", "stress", "forceful"] as const;
export const DEFAULT_PAUSE_DURATIONS_MS: Record<string, number> = {
  "short pause": 400,
  pause: 700,
  "long pause": 1200,
  break: 400,
  "long-break": 1200,
};
/** The hard cap on crop amount, whatever a policy says. */
export const CROP_HARD_CAP = 0.2;
export const REMOTION_TEMPLATES = [
  "title_card",
  "supplies_card",
  "pictogram_chart",
  "statement_card",
  "lower_third",
  "custom",
] as const;
export const SFX_PLACEMENTS = ["segment_start", "segment_end", "at_phrase", "whole_segment"] as const;
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
export const PIPELINE_FIRE_STATES = ["VALIDATED", "IMAGES_RECEIVED", "RENDER_COMPLETE", "STORY_VALIDATED"] as const;
export const BOT_TASK_TYPES = ["generate_images", "upload_youtube", "generate_location_master", "generate_character_group_master"] as const;

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
