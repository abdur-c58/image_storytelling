import "server-only";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { appSettings, stories } from "@/lib/db/schema";
import { NARRATOR } from "@/lib/episode/constants";
import { speakerVoices } from "@/lib/episode/resolve";
import type { ResolvedVoice, StoryBible } from "@/lib/episode/schema";

/** Voice ids entered on the Settings page, so a voice change needs no JSON, code or env edit. */
export interface VoiceSettings {
  /** Used by any speaker whose voice_id is empty (the narrator, usually). Before the worker's FISH_VOICE_ID. */
  default_voice_id: string;
  /** Channel character id → voice_id, applied in every story that uses the character. */
  channel: Record<string, string>;
}

export type VoiceSource = "story_page" | "channel_settings" | "story_json" | "default_settings" | "worker_env";

const KEY = "voices";
const VOICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function checkVoiceId(id: string): string {
  const v = id.trim();
  if (v && !VOICE_ID.test(v)) throw new Error("A voice id may only contain letters, digits, - and _ (at most 64).");
  return v;
}

export async function getVoiceSettings(db: Db): Promise<VoiceSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY));
  const v = (row?.value ?? {}) as Partial<VoiceSettings>;
  return { default_voice_id: v.default_voice_id ?? "", channel: { ...(v.channel ?? {}) } };
}

export async function saveVoiceSettings(db: Db, next: VoiceSettings): Promise<void> {
  const value: VoiceSettings = {
    default_voice_id: checkVoiceId(String(next.default_voice_id ?? "")),
    channel: Object.fromEntries(
      Object.entries(next.channel ?? {})
        .filter(([id]) => VOICE_ID.test(id))
        .map(([id, voice]) => [id, checkVoiceId(String(voice ?? ""))] as const)
        .filter(([, voice]) => voice),
    ),
  };
  await db
    .insert(appSettings)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: sql`now()` } });
}

/** Set (or clear, with "") one speaker's voice for one story. */
export async function setStoryVoice(db: Db, storyId: string, speaker: string, voiceId: string): Promise<void> {
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (!story) throw new Error("Story not found.");
  if (!story.bible) throw new Error("Add the story bible first.");
  const bible = story.bible as StoryBible;
  if (speaker !== NARRATOR && !bible.characters.some((c) => c.id === speaker && c.voice)) {
    throw new Error(`${speaker} has no voice in the story bible, so it can't speak.`);
  }
  const overrides = { ...(story.voiceOverrides as Record<string, string>) };
  const id = checkVoiceId(voiceId);
  if (id) overrides[speaker] = id;
  else delete overrides[speaker];
  await db.update(stories).set({ voiceOverrides: overrides, updatedAt: new Date() }).where(eq(stories.id, storyId));
}

/**
 * Layer the website's voice ids over the story's: Story page > Settings channel cast > story JSON >
 * Settings default > the worker's FISH_VOICE_ID (an empty voice_id).
 */
export function applyVoiceSettings(
  voices: Record<string, ResolvedVoice>,
  opts: { settings: VoiceSettings; storyOverrides?: Record<string, string>; channelIds?: Iterable<string> },
): { voices: Record<string, ResolvedVoice>; sources: Record<string, VoiceSource> } {
  const channel = new Set(opts.channelIds ?? []);
  const out: Record<string, ResolvedVoice> = {};
  const sources: Record<string, VoiceSource> = {};
  for (const [speaker, voice] of Object.entries(voices)) {
    let voiceId = voice.voice_id;
    let source: VoiceSource = voiceId ? "story_json" : "worker_env";
    const fromChannel = channel.has(speaker) ? opts.settings.channel[speaker] : "";
    const fromStory = opts.storyOverrides?.[speaker] ?? "";
    if (fromStory) [voiceId, source] = [fromStory, "story_page"];
    else if (fromChannel) [voiceId, source] = [fromChannel, "channel_settings"];
    else if (!voiceId && opts.settings.default_voice_id) [voiceId, source] = [opts.settings.default_voice_id, "default_settings"];
    out[speaker] = { ...voice, voice_id: voiceId };
    sources[speaker] = source;
  }
  return { voices: out, sources };
}

/** Every speaker's effective voice for a story, and where its voice_id came from. */
export async function storyVoices(db: Db, storyId: string) {
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (!story) throw new Error("Story not found.");
  if (!story.bible) throw new Error("Add the story bible first.");
  const bible = story.bible as StoryBible;
  return applyVoiceSettings(speakerVoices(bible, bible.defaults.voice), {
    settings: await getVoiceSettings(db),
    storyOverrides: story.voiceOverrides as Record<string, string>,
    channelIds: bible.characters.filter((c) => c.scope === "channel").map((c) => c.id),
  });
}

/** An episode's voices with the website's voice ids applied (used when a voice task is handed out). */
export async function episodeVoices(
  db: Db,
  storyId: string | null,
  voices: Record<string, ResolvedVoice>,
): Promise<Record<string, ResolvedVoice>> {
  const settings = await getVoiceSettings(db);
  if (!storyId) return applyVoiceSettings(voices, { settings }).voices;
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  const bible = story?.bible as StoryBible | undefined;
  return applyVoiceSettings(voices, {
    settings,
    storyOverrides: (story?.voiceOverrides ?? {}) as Record<string, string>,
    channelIds: bible?.characters.filter((c) => c.scope === "channel").map((c) => c.id),
  }).voices;
}
