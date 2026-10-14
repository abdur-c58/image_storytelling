import { z } from "zod";
import {
  BOT_TASK_TYPES,
  CARD_BACKGROUNDS,
  CHARACTER_ROLES,
  CROP_HARD_CAP,
  CROP_MEASURES,
  CROP_TRANSITIONS,
  DEFAULT_PAIRED_TAGS,
  DEFAULT_PAUSE_DURATIONS_MS,
  DEFAULT_TAG_WHITELIST,
  EASINGS,
  FRAME_POSITIONS,
  PIPELINE_FIRE_STATES,
  REMOTION_TEMPLATES,
  SCHEMA_VERSION,
  SEGMENT_TYPES,
  SFX_PLACEMENTS,
  TAG_FALLBACK_MODES,
  THUMBNAIL_POSITIONS,
  THUMBNAIL_TEXT_STYLES,
  TRANSITIONS,
  VISIBILITIES,
  WORLD_VARIABLE_TYPES,
  YOUTUBE_CATEGORIES,
} from "./constants";

// Every object is "loose": unknown keys are kept (stored) but ignored, so the
// contract can grow without breaking scripts written against an older version.
// `.prefault(x)` parses `x` through the schema, so nested defaults apply to omitted blocks.

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "Use letters, digits, '_' or '-' only.");

const nonEmpty = z.string().trim().min(1, "Must not be empty.");
const unit = z.number().min(0).max(1);

// ── Shared blocks (story defaults, episode overrides) ───────────────────────

const voiceFields = {
  provider: z.literal("fish_audio"),
  voice_id: z.string(),
  model: z.string(),
  speed: z.number().min(0.5).max(2),
  style_notes: z.string().max(120),
  pronunciation_overrides: z.record(z.string().min(1), z.string().min(1)),
  tag_whitelist: z.array(z.string().trim().min(1)),
  paired_tags: z.array(z.string().trim().min(1)),
  unknown_tag_level: z.enum(["warning", "error"]),
  max_tags_per_100_words: z.number().min(0).max(100),
  pause_between_sentences_ms: z.number().int().min(0).max(5000),
  pause_between_segments_ms: z.number().int().min(0).max(5000),
  tag_fallback_mode: z.enum(TAG_FALLBACK_MODES),
  pause_durations_ms: z.record(z.string().min(1), z.number().int().min(0).max(10000)),
};

export const VoiceSchema = z.looseObject({
  provider: voiceFields.provider.default("fish_audio"),
  voice_id: voiceFields.voice_id.default(""),
  model: voiceFields.model.default(""),
  speed: voiceFields.speed.default(1),
  style_notes: voiceFields.style_notes.default(""),
  pronunciation_overrides: voiceFields.pronunciation_overrides.default({}),
  tag_whitelist: voiceFields.tag_whitelist.default([...DEFAULT_TAG_WHITELIST]),
  paired_tags: voiceFields.paired_tags.default([...DEFAULT_PAIRED_TAGS]),
  unknown_tag_level: voiceFields.unknown_tag_level.default("warning"),
  max_tags_per_100_words: voiceFields.max_tags_per_100_words.default(8),
  pause_between_sentences_ms: voiceFields.pause_between_sentences_ms.default(350),
  pause_between_segments_ms: voiceFields.pause_between_segments_ms.default(450),
  tag_fallback_mode: voiceFields.tag_fallback_mode.default("split_and_silence"),
  pause_durations_ms: voiceFields.pause_durations_ms.default({ ...DEFAULT_PAUSE_DURATIONS_MS }),
});

const musicFields = {
  enabled: z.boolean(),
  query: z.string(),
  gain_db: z.number().min(-60).max(0),
  duck_under_voice: z.boolean(),
};

export const MusicSchema = z.looseObject({
  enabled: musicFields.enabled.default(false),
  query: musicFields.query.default(""),
  gain_db: musicFields.gain_db.default(-26),
  duck_under_voice: musicFields.duck_under_voice.default(true),
});

const audioFields = {
  master_loudness_lufs: z.number().min(-30).max(-8),
  true_peak_db: z.number().min(-9).max(0),
  voice_target_lufs: z.number().min(-30).max(-10),
  sfx_default_gain_db: z.number().min(-60).max(6),
};

export const AudioSchema = z.looseObject({
  master_loudness_lufs: audioFields.master_loudness_lufs.default(-14),
  true_peak_db: audioFields.true_peak_db.default(-1.5),
  voice_target_lufs: audioFields.voice_target_lufs.default(-16),
  sfx_default_gain_db: audioFields.sfx_default_gain_db.default(-18),
  music: MusicSchema.prefault({}),
});

const renderFields = {
  resolution: z.literal("1920x1080"),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  burn_in_captions: z.boolean(),
  caption_style: z.enum(["none", "bottom_bar", "bold_center"]),
  intro_sec: z.number().min(0).max(30),
  outro_sec: z.number().min(0).max(60),
  codec: z.literal("h264"),
  crf: z.number().int().min(10).max(35),
  audio_bitrate_kbps: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320)]),
};

export const RenderSchema = z.looseObject({
  resolution: renderFields.resolution.default("1920x1080"),
  fps: renderFields.fps.default(30),
  burn_in_captions: renderFields.burn_in_captions.default(false),
  caption_style: renderFields.caption_style.default("none"),
  intro_sec: renderFields.intro_sec.default(0),
  outro_sec: renderFields.outro_sec.default(0),
  codec: renderFields.codec.default("h264"),
  crf: renderFields.crf.default(18),
  audio_bitrate_kbps: renderFields.audio_bitrate_kbps.default(192),
});

const cropFields = {
  enabled: z.boolean(),
  max_crop: z.number().min(0).max(CROP_HARD_CAP, `max_crop is capped at ${CROP_HARD_CAP}.`),
  typical_max_crop: z.number().min(0).max(CROP_HARD_CAP),
  min_crop: z.number().min(0).max(CROP_HARD_CAP),
  prob_typical: unit,
  crop_measure: z.enum(CROP_MEASURES),
  sentences_before_crop: z.record(z.string().regex(/^[1-9]\d*$/, "Keys are sentence counts: \"1\", \"2\", …"), unit),
  hold_sentences: z.number().int().min(1).max(10),
  min_hold_sec: z.number().min(0).max(30),
  transition: z.enum(CROP_TRANSITIONS),
  transition_ms: z.number().int().min(0).max(3000),
  easing: z.enum(EASINGS),
  focal_bias: unit,
  avoid_repeat_region: z.boolean(),
  end_on_full_frame: z.boolean(),
  seed_mode: z.enum(["per_project", "fixed"]),
  seed: z.number().int().nullable(),
};

export const CropPolicySchema = z.looseObject({
  enabled: cropFields.enabled.default(true),
  max_crop: cropFields.max_crop.default(0.2),
  typical_max_crop: cropFields.typical_max_crop.default(0.1),
  min_crop: cropFields.min_crop.default(0.04),
  prob_typical: cropFields.prob_typical.default(0.85),
  crop_measure: cropFields.crop_measure.default("linear"),
  sentences_before_crop: cropFields.sentences_before_crop.default({ "2": 0.8, "1": 0.2 }),
  hold_sentences: cropFields.hold_sentences.default(1),
  min_hold_sec: cropFields.min_hold_sec.default(1.5),
  transition: cropFields.transition.default("ease"),
  transition_ms: cropFields.transition_ms.default(450),
  easing: cropFields.easing.default("easeInOutCubic"),
  focal_bias: cropFields.focal_bias.default(0.6),
  avoid_repeat_region: cropFields.avoid_repeat_region.default(true),
  end_on_full_frame: cropFields.end_on_full_frame.default(false),
  seed_mode: cropFields.seed_mode.default("per_project"),
  seed: cropFields.seed.default(null),
});

const partial = <T extends Record<string, z.ZodType>>(fields: T) =>
  z.looseObject(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> });

export const VoiceOverrideSchema = partial(voiceFields);
export const AudioOverrideSchema = partial({ ...audioFields, music: partial(musicFields) });
export const RenderOverrideSchema = partial(renderFields);
export const CropOverrideSchema = partial(cropFields);

// ── Story bible ─────────────────────────────────────────────────────────────

export const OutfitStateSchema = z.looseObject({
  id: slug,
  description: z.string().default(""),
});

export const CharacterSchema = z.looseObject({
  id: slug,
  name: nonEmpty,
  role: z.enum(CHARACTER_ROLES).default("extra"),
  visual_description: nonEmpty,
  outfit_states: z.array(OutfitStateSchema).default([]),
  reference_image_ids: z.array(slug).default([]),
  first_appears_episode: z.number().int().min(1).default(1),
});

export const WorldVariableSchema = z.looseObject({
  id: slug,
  type: z.enum(WORLD_VARIABLE_TYPES),
  initial: z.union([z.number(), z.string()]),
  values: z.array(z.string()).default([]),
  prompt_template: z.string().default(""),
  applies_to_location_tags: z.array(z.string()).default([]),
  monotonic: z.enum(["increasing", "decreasing"]).nullable().default(null),
  max_step_per_segment: z.number().positive().nullable().default(null),
});

export const CameraAngleSchema = z.looseObject({
  id: slug,
  name: z.string().default(""),
  prompt: nonEmpty,
});

export const LocationStateSchema = z.looseObject({
  id: slug,
  description: z.string().default(""),
  is_base: z.boolean().default(false),
  derived_from: slug.nullable().default(null),
});

export const KeyPropSchema = z.looseObject({
  id: slug,
  description: nonEmpty,
  default_position: z.string().default(""),
});

export const LocationSchema = z.looseObject({
  id: slug,
  name: nonEmpty,
  tags: z.array(z.string()).default([]),
  anchor_description: nonEmpty,
  fixed_landmarks: z.array(z.string()).default([]),
  camera_angles: z.array(CameraAngleSchema).min(1, "A location needs at least one camera angle."),
  states: z.array(LocationStateSchema).min(1, "A location needs at least one state."),
  key_props: z.array(KeyPropSchema).default([]),
});

export const SceneBibleSchema = z.looseObject({
  world_variables: z.array(WorldVariableSchema).default([]),
  locations: z.array(LocationSchema).default([]),
});

export const ChannelSchema = z.looseObject({
  channel_name: nonEmpty,
  recurring_cameo: z
    .looseObject({
      description: nonEmpty,
      rule: z.string().default(""),
      min_segments_per_episode: z.number().int().min(0).nullable().default(null),
    })
    .nullable()
    .default(null),
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
  source_image_min_width: z.number().int().min(1280).max(8192).default(2560),
  palette_notes: z.string().default(""),
  reference_assets: z.array(ReferenceAssetSchema).default([]),
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
  retry: RetrySchema.prefault({}),
  timeout_minutes: z.number().int().min(5).max(24 * 60).default(180),
});

export const StoryDefaultsSchema = z.looseObject({
  voice: VoiceSchema.prefault({}),
  audio: AudioSchema.prefault({}),
  render: RenderSchema.prefault({}),
  crop_policy: CropPolicySchema.prefault({}),
});

export const StoryAutomationSchema = z.looseObject({
  approval_gates: z.looseObject({ location_masters: z.boolean().default(true) }).prefault({}),
  bot_triggers: z.array(BotTriggerSchema).default([]),
});

export const StoryBibleSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  doc_type: z.literal("story_bible"),
  story_id: slug,
  story_title: nonEmpty,
  total_episodes_planned: z.number().int().min(1).nullable().default(null),
  channel: ChannelSchema,
  style_bible: StyleBibleSchema,
  characters: z.array(CharacterSchema).default([]),
  scene_bible: SceneBibleSchema.prefault({}),
  defaults: StoryDefaultsSchema.prefault({}),
  automation: StoryAutomationSchema.prefault({}),
});

// ── Episode ─────────────────────────────────────────────────────────────────

export const SeriesSchema = z.looseObject({
  episode_number: z.number().int().min(1),
  episode_title_short: nonEmpty,
  recap_of_previous: z.string().default(""),
  cliffhanger: z.string().default(""),
  next_episode_teaser: z.string().default(""),
  state_carryover: z.record(z.string(), z.unknown()).default({}),
});

export const SceneCharacterSchema = z.looseObject({
  character_id: slug,
  outfit_state_id: slug.nullable().default(null),
  pose_or_action: z.string().default(""),
  position_in_frame: z.enum(FRAME_POSITIONS).default("center"),
  cameo: z.boolean().default(false),
});

export const StateChangeSchema = z.looseObject({
  location_id: slug,
  from_state_id: slug,
  to_state_id: slug,
  cause: nonEmpty,
  persist: z.boolean({ error: '"persist" is required (true or false).' }),
});

const worldValue = z.union([z.number(), z.string()]);

export const SceneSchema = z.looseObject({
  location_id: slug,
  state_id: slug,
  camera_angle_id: slug,
  world_state: z.record(z.string(), worldValue).default({}),
  characters_present: z.array(SceneCharacterSchema).default([]),
  props_in_frame: z.array(slug).default([]),
  state_changes: z.array(StateChangeSchema).default([]),
  include_channel_cameo: z.boolean().default(false),
});

export const ThumbnailSceneSchema = z.looseObject({
  location_id: slug,
  state_id: slug,
  camera_angle_id: slug,
  world_state: z.record(z.string(), worldValue).default({}),
});

export const FocalPointSchema = z.looseObject({
  label: z.string().default(""),
  x: unit,
  y: unit,
});

export const ImageSchema = z.looseObject({
  prompt: z.string().default(""),
  focal_points: z.array(FocalPointSchema).default([]),
  crop_override: CropOverrideSchema.nullable().default(null),
  negative_prompt_extra: z.string().default(""),
  reuse_from_segment_id: slug.nullable().default(null),
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
  props: RemotionPropsSchema.prefault({}),
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
  sentence_split_override: z.array(z.string().trim().min(1)).nullable().default(null),
  min_duration_sec: z.number().positive().max(60).nullable().default(null),
  silent: z.boolean().default(false),
  scene: SceneSchema.nullable().default(null),
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
  scene: ThumbnailSceneSchema.nullable().default(null),
  characters_present: z.array(slug).default([]),
  text_layers: z.array(ThumbnailTextLayerSchema).max(4).default([]),
  safe_zone_note: z.string().default(""),
  alt_variants: z.number().int().min(0).max(2).default(0),
});

export const YoutubeSchema = z.looseObject({
  channel_name: z.string().default(""),
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

export const AutomationSchema = z.looseObject({
  auto_start_on_submit: z.boolean().default(true),
  approval_gates: z
    .looseObject({
      before_render: z.boolean().default(false),
      before_publish: z.boolean().default(false),
    })
    .prefault({}),
  bot_triggers: z.array(BotTriggerSchema).default([]),
});

export const OverridesSchema = z.looseObject({
  voice: VoiceOverrideSchema.optional(),
  audio: AudioOverrideSchema.optional(),
  render: RenderOverrideSchema.optional(),
  crop_policy: CropOverrideSchema.optional(),
});

export const BibleAdditionsSchema = z.looseObject({
  characters: z.array(CharacterSchema).default([]),
  locations: z.array(LocationSchema).default([]),
  location_states: z.array(z.looseObject({ location_id: slug, state: LocationStateSchema })).default([]),
  camera_angles: z.array(z.looseObject({ location_id: slug, angle: CameraAngleSchema })).default([]),
  key_props: z.array(z.looseObject({ location_id: slug, prop: KeyPropSchema })).default([]),
  outfit_states: z.array(z.looseObject({ character_id: slug, outfit: OutfitStateSchema })).default([]),
  world_variables: z.array(WorldVariableSchema).default([]),
});

export const EpisodeDocSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  doc_type: z.literal("episode"),
  story_id: slug,
  series: SeriesSchema,
  segments: z.array(SegmentSchema).min(1, "At least one segment is required."),
  thumbnail: ThumbnailSchema,
  youtube: YoutubeSchema,
  chapters: z.array(ChapterSchema).default([]),
  automation: AutomationSchema.prefault({}),
  overrides: OverridesSchema.prefault({}),
  bible_additions: BibleAdditionsSchema.prefault({}),
});

export const BundleSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  doc_type: z.literal("bundle"),
  story_bible: StoryBibleSchema,
  episode: EpisodeDocSchema,
});

export type StoryBible = z.output<typeof StoryBibleSchema>;
export type EpisodeDoc = z.output<typeof EpisodeDocSchema>;
export type Bundle = z.output<typeof BundleSchema>;
export type Voice = z.output<typeof VoiceSchema>;
export type Audio = z.output<typeof AudioSchema>;
export type Render = z.output<typeof RenderSchema>;
export type CropPolicy = z.output<typeof CropPolicySchema>;
export type CropOverride = z.output<typeof CropOverrideSchema>;
export type StoryCharacter = z.output<typeof CharacterSchema>;
export type Character = StoryCharacter;
export type Location = z.output<typeof LocationSchema>;
export type WorldVariable = z.output<typeof WorldVariableSchema>;
export type Scene = z.output<typeof SceneSchema>;
export type BibleAdditions = z.output<typeof BibleAdditionsSchema>;

/**
 * What the pipeline and the worker read: the episode with its story's style, characters, scene bible and
 * defaults merged in (see lib/episode/resolve.ts). Keeps the v1 field names the worker already uses.
 */
export type Episode = EpisodeDoc & {
  series: EpisodeDoc["series"] & { series_id: string; series_title: string; total_episodes_planned: number | null };
  style_bible: StoryBible["style_bible"] & {
    characters: { id: string; name: string; visual_description: string; reference_image_ids: string[] }[];
  };
  voice: Voice;
  audio: Audio;
  render: Render;
  crop_policy: CropPolicy;
  story: {
    story_id: string;
    story_title: string;
    channel: StoryBible["channel"];
    characters: StoryCharacter[];
    scene_bible: StoryBible["scene_bible"];
    /** Story state at the start of this episode (see lib/episode/continuity.ts). */
    start_state?: {
      locations: Record<string, string>;
      world: Record<string, number | string>;
      outfits: Record<string, string>;
    };
  };
};
export type Segment = Episode["segments"][number];
export type SfxCue = Segment["sfx"][number];
