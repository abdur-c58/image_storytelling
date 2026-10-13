import { z } from "zod";
import {
  BOT_TASK_TYPES,
  CARD_BACKGROUNDS,
  MOTIONS,
  PIPELINE_FIRE_STATES,
  REMOTION_TEMPLATES,
  SCHEMA_VERSION,
  SEGMENT_TYPES,
  SFX_PLACEMENTS,
  THUMBNAIL_POSITIONS,
  THUMBNAIL_TEXT_STYLES,
  TRANSITIONS,
  VISIBILITIES,
  YOUTUBE_CATEGORIES,
} from "./constants";

// Every object is "loose": unknown keys are kept (stored) but ignored, so the
// contract can grow without breaking scripts written against an older version.

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Use letters, digits, '_' or '-' only.");

const nonEmpty = z.string().trim().min(1, "Must not be empty.");

export const StateCarryoverSchema = z.looseObject({
  day_counter_end: z.number().int().nullable().default(null),
  resources: z.record(z.string(), z.unknown()).default({}),
  characters_status: z.record(z.string(), z.unknown()).default({}),
});

export const SeriesSchema = z.looseObject({
  series_id: slug,
  series_title: nonEmpty,
  episode_number: z.number().int().min(1),
  total_episodes_planned: z.number().int().min(1).nullable().default(null),
  episode_title_short: nonEmpty,
  recap_of_previous: z.string().default(""),
  cliffhanger: z.string().default(""),
  next_episode_teaser: z.string().default(""),
  state_carryover: StateCarryoverSchema.default({ day_counter_end: null, resources: {}, characters_status: {} }),
});

export const CharacterSchema = z.looseObject({
  id: slug,
  name: nonEmpty,
  visual_description: nonEmpty,
  reference_image_ids: z.array(slug).default([]),
});

export const ReferenceAssetSchema = z.looseObject({
  id: slug,
  description: z.string().default(""),
  asset_url_or_path: z.string().default(""),
});

export const StyleBibleSchema = z.looseObject({
  global_style_prompt: nonEmpty,
  negative_prompt: z.string().default(""),
  aspect_ratio: z.literal("16:9").default("16:9"),
  target_resolution: z.literal("1920x1080").default("1920x1080"),
  palette_notes: z.string().default(""),
  characters: z.array(CharacterSchema).default([]),
  reference_assets: z.array(ReferenceAssetSchema).default([]),
});

export const VoiceSchema = z.looseObject({
  provider: z.literal("fish_audio").default("fish_audio"),
  voice_id: z.string().default(""),
  model: z.string().default(""),
  speed: z.number().min(0.5).max(2).default(1),
  style_notes: z.string().max(120).default(""),
  pronunciation_overrides: z.record(z.string().min(1), z.string().min(1)).default({}),
  pause_between_segments_ms: z.number().int().min(0).max(5000).default(250),
});

export const MusicSchema = z.looseObject({
  enabled: z.boolean().default(false),
  query: z.string().default(""),
  gain_db: z.number().min(-60).max(0).default(-26),
  duck_under_voice: z.boolean().default(true),
});

export const AudioSchema = z.looseObject({
  master_loudness_lufs: z.number().min(-30).max(-8).default(-14),
  true_peak_db: z.number().min(-9).max(0).default(-1.5),
  voice_target_lufs: z.number().min(-30).max(-10).default(-16),
  sfx_default_gain_db: z.number().min(-60).max(6).default(-18),
  music: MusicSchema.default({ enabled: false, query: "", gain_db: -26, duck_under_voice: true }),
});

export const ImageSchema = z.looseObject({
  prompt: z.string().default(""),
  characters_present: z.array(slug).default([]),
  shot_type: z.string().default(""),
  mood: z.string().default(""),
  time_of_day: z.string().default(""),
  negative_prompt_extra: z.string().default(""),
  reuse_from_segment_id: slug.nullable().default(null),
  motion: z.enum(MOTIONS).default("none"),
});

export const RemotionItemSchema = z.looseObject({
  label: z.string().default(""),
  value: z.union([z.string(), z.number()]).nullable().default(null),
  icon: z.string().default(""),
  icon_count: z.number().int().min(0).max(100).nullable().default(null),
  icon_total: z.number().int().min(0).max(100).nullable().default(null),
});

export const RemotionPropsSchema = z.looseObject({
  title: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  background: z.enum(CARD_BACKGROUNDS).default("dark"),
  background_image_segment_id: slug.nullable().default(null),
  items: z.array(RemotionItemSchema).default([]),
  footer: z.string().nullable().default(null),
  accent: z.enum(["red", "blue", "none"]).default("red"),
});

export const RemotionSchema = z.looseObject({
  template: z.enum(REMOTION_TEMPLATES),
  props: RemotionPropsSchema.default({
    title: null,
    subtitle: null,
    body: null,
    background: "dark",
    background_image_segment_id: null,
    items: [],
    footer: null,
    accent: "red",
  }),
});

export const SfxCueSchema = z.looseObject({
  id: slug,
  search_query: nonEmpty,
  alt_queries: z.array(z.string()).default([]),
  must_include_tags: z.array(z.string()).default([]),
  exclude_tags: z.array(z.string()).default([]),
  placement: z.enum(SFX_PLACEMENTS).default("segment_start"),
  at_phrase: z.string().nullable().default(null),
  offset_sec: z.number().min(-30).max(120).default(0),
  duration_sec: z.number().positive().max(600).nullable().default(null),
  loop: z.boolean().default(false),
  gain_db: z.number().min(-60).max(12).nullable().default(null),
  fade_in_ms: z.number().int().min(0).max(10000).default(100),
  fade_out_ms: z.number().int().min(0).max(10000).default(300),
  continues_into_next: z.boolean().default(false),
});

export const SegmentSchema = z.looseObject({
  id: slug,
  order: z.number().int().min(1),
  type: z.enum(SEGMENT_TYPES),
  narration: z.string().default(""),
  tts_text: z.string().nullable().default(null),
  caption_text: z.string().nullable().default(null),
  delivery: z.string().max(120).nullable().default(null),
  min_duration_sec: z.number().positive().max(60).nullable().default(null),
  silent: z.boolean().default(false),
  image: ImageSchema.nullable().default(null),
  remotion: RemotionSchema.nullable().default(null),
  sfx: z.array(SfxCueSchema).default([]),
  transition_out: z.enum(TRANSITIONS).default("cut"),
});

export const ThumbnailTextLayerSchema = z.looseObject({
  text: nonEmpty,
  style: z.enum(THUMBNAIL_TEXT_STYLES).default("impact_white_black_outline"),
  position: z.enum(THUMBNAIL_POSITIONS).default("top_center"),
  max_font_size_px: z.number().int().min(24).max(400).default(200),
});

export const ThumbnailSchema = z.looseObject({
  image_prompt: nonEmpty,
  characters_present: z.array(slug).default([]),
  text_layers: z.array(ThumbnailTextLayerSchema).max(4).default([]),
  safe_zone_note: z.string().default(""),
  alt_variants: z.number().int().min(0).max(2).default(0),
});

export const YoutubeSchema = z.looseObject({
  channel_name: nonEmpty,
  title: nonEmpty,
  description: z.string().default(""),
  tags: z.array(z.string().trim().min(1)).default([]),
  category: z
    .enum(Object.keys(YOUTUBE_CATEGORIES) as [string, ...string[]])
    .default("Entertainment"),
  language: z.string().min(2).max(10).default("en"),
  visibility: z.enum(VISIBILITIES).default("private"),
  scheduled_publish_at: z.iso.datetime({ offset: true }).nullable().default(null),
  playlist: z.string().nullable().default(null),
  made_for_kids: z.boolean().default(false),
  contains_altered_or_synthetic_media: z.boolean().default(true),
  comments_enabled: z.boolean().default(true),
  pinned_comment: z.string().max(10000).nullable().default(null),
  end_screen_note: z.string().nullable().default(null),
  chapters_from_segments: z.boolean().default(true),
});

export const ChapterSchema = z.looseObject({
  segment_id: slug,
  title: z.string().trim().min(1).max(100),
});

export const RetrySchema = z.looseObject({
  max_attempts: z.number().int().min(1).max(10).default(3),
  backoff_sec: z.number().int().min(0).max(86400).default(60),
});

export const BotTriggerSchema = z.looseObject({
  trigger_id: slug,
  bot_task_type: z.enum(BOT_TASK_TYPES),
  fire_when: z.enum(PIPELINE_FIRE_STATES).default("VALIDATED"),
  depends_on: z.array(slug).default([]),
  image_provider: z.string().default("google_flow"),
  batch_size: z.number().int().min(1).max(100).default(8),
  output_naming: z.string().default("{segment_id}.png"),
  retry: RetrySchema.default({ max_attempts: 3, backoff_sec: 60 }),
  timeout_minutes: z.number().int().min(5).max(24 * 60).default(180),
});

export const AutomationSchema = z.looseObject({
  auto_start_on_submit: z.boolean().default(true),
  approval_gates: z
    .looseObject({
      before_render: z.boolean().default(false),
      before_publish: z.boolean().default(false),
    })
    .default({ before_render: false, before_publish: false }),
  bot_triggers: z.array(BotTriggerSchema).default([]),
});

export const RenderSchema = z.looseObject({
  resolution: z.literal("1920x1080").default("1920x1080"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
  burn_in_captions: z.boolean().default(false),
  caption_style: z.enum(["none", "bottom_bar", "bold_center"]).default("none"),
  intro_sec: z.number().min(0).max(30).default(0),
  outro_sec: z.number().min(0).max(60).default(0),
  codec: z.literal("h264").default("h264"),
  crf: z.number().int().min(10).max(35).default(18),
  audio_bitrate_kbps: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320)]).default(192),
});

export const EpisodeObjectSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  series: SeriesSchema,
  style_bible: StyleBibleSchema,
  voice: VoiceSchema.default({
    provider: "fish_audio",
    voice_id: "",
    model: "",
    speed: 1,
    style_notes: "",
    pronunciation_overrides: {},
    pause_between_segments_ms: 250,
  }),
  audio: AudioSchema.default({
    master_loudness_lufs: -14,
    true_peak_db: -1.5,
    voice_target_lufs: -16,
    sfx_default_gain_db: -18,
    music: { enabled: false, query: "", gain_db: -26, duck_under_voice: true },
  }),
  segments: z.array(SegmentSchema).min(1, "At least one segment is required."),
  thumbnail: ThumbnailSchema,
  youtube: YoutubeSchema,
  chapters: z.array(ChapterSchema).default([]),
  automation: AutomationSchema.default({
    auto_start_on_submit: true,
    approval_gates: { before_render: false, before_publish: false },
    bot_triggers: [],
  }),
  render: RenderSchema.default({
    resolution: "1920x1080",
    fps: 30,
    burn_in_captions: false,
    caption_style: "none",
    intro_sec: 0,
    outro_sec: 0,
    codec: "h264",
    crf: 18,
    audio_bitrate_kbps: 192,
  }),
});

export type Episode = z.output<typeof EpisodeObjectSchema>;
export type EpisodeInput = z.input<typeof EpisodeObjectSchema>;
export type Segment = Episode["segments"][number];
export type SfxCue = Segment["sfx"][number];
export type Character = Episode["style_bible"]["characters"][number];
