import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** One per story bible (schema 2.0). Episodes (projects) point at it. */
export const stories = pgTable("stories", {
  /** The bible's story_id. */
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** STORY_VALIDATED | LOCATION_MASTERS_REQUESTED | MASTERS_REVIEW | MASTERS_APPROVED */
  state: text("state").notNull(),
  stateDetail: text("state_detail").notNull().default(""),
  /** Parsed story bible (defaults applied). */
  bible: jsonb("bible").notNull(),
  rawJson: text("raw_json").notNull(),
  /** { current, by_episode, committed_through_episode } — see lib/episode/continuity.ts */
  storyState: jsonb("story_state").notNull(),
  warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/** Recurring cast shared by every story on the channel (schema 2.1 `scope: "channel"`). */
export const channelCharacters = pgTable("channel_characters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Full character definition (outfits grow as stories add them). */
  definition: jsonb("definition").notNull(),
  /** style_bible.reference_assets entries its reference_image_ids point at. */
  referenceAssets: jsonb("reference_assets").notNull().default(sql`'[]'::jsonb`),
  /** The story that first defined it; only that story may change the definition. */
  originStoryId: text("origin_story_id").notNull(),
  /** master_key (char/<id>/<outfit>) → { story_id, asset_id } of an approved sheet, reused by later stories. */
  masters: jsonb("masters").notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/** Location plates and character sheets a story's images are anchored to. */
export const storyMasters = pgTable(
  "story_masters",
  {
    storyId: text("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    /** loc/<location>/<state>/<angle> or char/<character>/<outfit> */
    masterKey: text("master_key").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull().default(""),
    prompt: text("prompt").notNull(),
    negativePrompt: text("negative_prompt").notNull().default(""),
    promptParts: jsonb("prompt_parts").notNull().default(sql`'[]'::jsonb`),
    mustMatch: jsonb("must_match").notNull().default(sql`'[]'::jsonb`),
    /** missing | requested | generated | approved */
    status: text("status").notNull().default("missing"),
    approvedAssetId: text("approved_asset_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.storyId, t.masterKey] })],
).enableRLS();

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    storyId: text("story_id").references(() => stories.id, { onDelete: "set null" }),
    /** Seed for the crop engine; changed by "re-roll all". */
    cropSeed: text("crop_seed").notNull().default(""),
    seriesId: text("series_id").notNull(),
    episodeNumber: integer("episode_number").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull(),
    stateDetail: text("state_detail").notNull().default(""),
    episode: jsonb("episode").notNull(),
    rawJson: text("raw_json").notNull(),
    estimate: jsonb("estimate").notNull(),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    /** Approval timestamps for the optional gates. */
    approvedRenderAt: timestamp("approved_render_at", { withTimezone: true }),
    approvedPublishAt: timestamp("approved_publish_at", { withTimezone: true }),
    /** Final description / chapters / credits computed after render. */
    outputs: jsonb("outputs").notNull().default(sql`'{}'::jsonb`),
    youtubeUrl: text("youtube_url"),
    youtubeVideoId: text("youtube_video_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    error: text("error"),
    archived: boolean("archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_series_idx").on(t.seriesId, t.episodeNumber)],
).enableRLS();

export const segments = pgTable(
  "segments",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    segmentId: text("segment_id").notNull(),
    order: integer("order").notNull(),
    type: text("type").notNull(),
    narration: text("narration").notNull().default(""),
    finalPrompt: text("final_prompt"),
    negativePrompt: text("negative_prompt"),
    /** Labelled pieces of final_prompt, for the prompt inspector. */
    promptParts: jsonb("prompt_parts").notNull().default(sql`'[]'::jsonb`),
    /** Story masters this segment's image is anchored to. */
    masterKeys: jsonb("master_keys").notNull().default(sql`'[]'::jsonb`),
    imageAttempts: integer("image_attempts").notNull().default(0),
    /** null follows the crop policy; true/false is the per-segment toggle. */
    cropEnabled: boolean("crop_enabled"),
    /** Bumped by "re-roll" for this segment. */
    cropSalt: integer("crop_salt").notNull().default(0),
    /** normal | split_and_silence (voice tag fallback) */
    voiceMode: text("voice_mode").notNull().default("normal"),
    audioDurationSec: doublePrecision("audio_duration_sec"),
    startSec: doublePrecision("start_sec"),
    endSec: doublePrecision("end_sec"),
    /** Whisper QA: { wer, transcript, flagged } */
    qa: jsonb("qa").notNull().default(sql`'{}'::jsonb`),
    /** Per-line windows inside this segment's voice file: [{ line_id, speaker, start, end, voice_effect }] (seconds). */
    lineTimings: jsonb("line_timings").notNull().default(sql`'[]'::jsonb`),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.segmentId] })],
).enableRLS();

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    /** Exactly one of projectId / storyId is set. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    storyId: text("story_id").references(() => stories.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    /** Logical slot, e.g. image/seg_004, voice/seg_004, card/seg_010, sfx/seg_002_sfx_1, video/final, master/loc/x/y/z. */
    assetKey: text("asset_key").notNull(),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    width: integer("width"),
    height: integer("height"),
    durationSec: doublePrecision("duration_sec"),
    /** pending | ready | rejected | superseded */
    status: text("status").notNull(),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_project_key_idx").on(t.projectId, t.assetKey, t.status),
    index("assets_story_key_idx").on(t.storyId, t.assetKey, t.status),
  ],
).enableRLS();

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    /** Exactly one of projectId / storyId is set (story tasks: generate_location_master). */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    storyId: text("story_id").references(() => stories.id, { onDelete: "cascade" }),
    /** bot | worker */
    kind: text("kind").notNull(),
    /** generate_images | generate_location_master | upload_youtube | voice | align | sfx | cards | thumbnail_compose | mix | render */
    type: text("type").notNull(),
    /** Distinguishes several tasks of one type (image batches, single-segment redo). */
    scope: text("scope").notNull().default("all"),
    /** queued | leased | done | failed | dead | cancelled | superseded */
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    result: jsonb("result"),
    progress: jsonb("progress").notNull().default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    backoffSec: integer("backoff_sec").notNull().default(60),
    timeoutMinutes: integer("timeout_minutes").notNull().default(60),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseId: text("lease_id"),
    leasedBy: text("leased_by"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    firstLeasedAt: timestamp("first_leased_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("tasks_queue_idx").on(t.kind, t.status, t.availableAt),
    index("tasks_project_idx").on(t.projectId, t.type, t.scope),
    index("tasks_story_idx").on(t.storyId, t.type, t.scope),
  ],
).enableRLS();

export const taskEvents = pgTable(
  "task_events",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    storyId: text("story_id").references(() => stories.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    data: jsonb("data"),
    createdAt: createdAt(),
  },
  (t) => [
    index("task_events_project_idx").on(t.projectId, t.createdAt),
    index("task_events_story_idx").on(t.storyId, t.createdAt),
  ],
).enableRLS();

/** One row per SFX cue: the ranked candidates and which one is in use. */
export const sfxCues = pgTable(
  "sfx_cues",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cueId: text("cue_id").notNull(),
    segmentId: text("segment_id").notNull(),
    candidates: jsonb("candidates").notNull().default(sql`'[]'::jsonb`),
    selectedIndex: integer("selected_index").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.cueId] })],
).enableRLS();

/** Clip metadata shared across projects (licence + credit), keyed by provider:source_id. */
export const sfxCache = pgTable("sfx_cache", {
  clipKey: text("clip_key").primaryKey(),
  provider: text("provider").notNull(),
  sourceId: text("source_id").notNull(),
  title: text("title").notNull().default(""),
  author: text("author").notNull().default(""),
  license: text("license").notNull(),
  licenseUrl: text("license_url").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  attributionRequired: boolean("attribution_required").notNull().default(false),
  durationSec: doublePrecision("duration_sec"),
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
}).enableRLS();

/** Generic key/value cache with expiry (provider lookups, signed URL memo, etc.). */
export const apiCache = pgTable("api_cache", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** bot | worker */
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_tokens_hash_idx").on(t.tokenHash)],
).enableRLS();

/** Last-seen heartbeat per worker / bot client. */
export const agents = pgTable("agents", {
  agentId: text("agent_id").primaryKey(),
  role: text("role").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  info: jsonb("info").notNull().default(sql`'{}'::jsonb`),
}).enableRLS();

export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id"),
    provider: text("provider").notNull(),
    unit: text("unit").notNull(),
    quantity: doublePrecision("quantity").notNull(),
    meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("usage_provider_idx").on(t.provider, t.createdAt)],
).enableRLS();

export type StoryRow = typeof stories.$inferSelect;
export type StoryMasterRow = typeof storyMasters.$inferSelect;
export type ChannelCharacterRow = typeof channelCharacters.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type SegmentRow = typeof segments.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type SfxCueRow = typeof sfxCues.$inferSelect;
