import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { assets, episodes, projects, segments, stories, storyMasters, tasks, type StoryMasterRow, type StoryRow, type TaskRow } from "@/lib/db/schema";
import { initialStoryState, type StoryStateSnapshot } from "@/lib/episode/continuity";
import { buildMasterItems, episodeMasterKeys, type MasterItem } from "@/lib/episode/prompt";
import { NARRATOR } from "@/lib/episode/constants";
import { applyBibleAdditions, upgradeStoredBible } from "@/lib/episode/resolve";
import { StoryDefaultsSchema, type BibleAdditions, type Episode, type StoryBible } from "@/lib/episode/schema";
import type { StoryContext } from "@/lib/episode/validate";
import { createTask, logEvent, type Owner } from "@/lib/queue";
import { getStorage, storyObjectPrefix } from "@/lib/storage";
import { loadCastRegistry, recordChannelMaster, registerChannelCast, reuseChannelMasters } from "./cast";
import { computeStoryState, recordSnapshot, refreshStoryStateCache } from "./snapshots";
import { storyVoices } from "./voices";

export const STORY_STATES = ["NO_BIBLE", "STORY_VALIDATED", "LOCATION_MASTERS_REQUESTED", "MASTERS_REVIEW", "MASTERS_APPROVED"] as const;
export type StoryStateName = (typeof STORY_STATES)[number];

const MAX_MASTER_ATTEMPTS = 3;
const isActive = (t: TaskRow) => t.status === "queued" || t.status === "leased";

export const masterAssetKey = (masterKey: string) => `master/${masterKey}`;

export function mastersGateOn(bible: StoryBible): boolean {
  return bible.automation.approval_gates.location_masters;
}

export async function getStory(db: Db, storyId: string): Promise<StoryRow | null> {
  const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
  return row ? { ...row, bible: row.bible ? upgradeStoredBible(row.bible) : null } : null;
}

/** The stored bible, or a clear error for a folder that has none yet. */
export function requireBible(story: StoryRow): StoryBible {
  if (!story.bible) throw new Error(`Story "${story.title}" has no story bible yet. Add the story bible first.`);
  return story.bible as StoryBible;
}

/**
 * The bible episodes are resolved against: the folder's title (renames are title-only and win over the
 * bible's story_title) and the Settings tab's defaults override merged in.
 */
export function effectiveBible(story: StoryRow): StoryBible {
  const bible = structuredClone(requireBible(story));
  bible.story_title = story.title;
  const override = story.defaultsOverride as Record<string, Record<string, unknown> | undefined>;
  if (override && Object.keys(override).length) {
    const merged: Record<string, unknown> = { ...bible.defaults };
    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v === "object") merged[k] = { ...((bible.defaults as Record<string, unknown>)[k] as object), ...v };
    }
    const parsed = StoryDefaultsSchema.safeParse(merged);
    if (parsed.success) bible.defaults = parsed.data as StoryBible["defaults"];
  }
  return bible;
}

/** Numbers of the episodes in a story folder (any version). */
export async function episodeNumbers(db: Db, storyId: string): Promise<number[]> {
  const rows = await db
    .select({ n: episodes.number })
    .from(episodes)
    .where(and(eq(episodes.storyId, storyId), isNotNull(episodes.activeVersionId)));
  return rows.map((r) => r.n).sort((a, b) => a - b);
}

/** Titles of the episodes in a story folder, by number. */
export async function episodeTitles(db: Db, storyId: string): Promise<Record<number, string>> {
  const rows = await db
    .select({ n: episodes.number, title: episodes.title })
    .from(episodes)
    .where(and(eq(episodes.storyId, storyId), isNotNull(episodes.activeVersionId)));
  return Object.fromEntries(rows.map((r) => [r.n, r.title]));
}

/** Everything an episode of this story is validated against. Null for unknown, deleted or bible-less folders. */
export async function loadStoryContext(db: Db, storyId: string): Promise<StoryContext | null> {
  const story = await getStory(db, storyId);
  if (!story || !story.bible || story.status === "deleted") return null;
  const bible = effectiveBible(story);
  const approved = await db
    .select({ key: storyMasters.masterKey })
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "approved")));
  return {
    bible,
    state: await computeStoryState(db, storyId, bible),
    approvedMasters: new Set(approved.map((r) => r.key)),
    mastersGate: mastersGateOn(bible),
    existingEpisodes: await episodeNumbers(db, storyId),
    episodeTitles: await episodeTitles(db, storyId),
  };
}

/** Ids a later bible must keep once episodes exist (append-only, like bible_additions). */
export function bibleIds(b: StoryBible): string[] {
  return [
    ...b.characters.flatMap((c) => [`character ${c.id}`, ...c.outfit_states.map((o) => `outfit ${c.id}/${o.id}`)]),
    ...b.scene_bible.world_variables.map((v) => `world variable ${v.id}`),
    ...b.scene_bible.locations.flatMap((l) => [
      `location ${l.id}`,
      ...l.states.map((s) => `state ${l.id}/${s.id}`),
      ...l.camera_angles.map((a) => `camera angle ${l.id}/${a.id}`),
      ...l.key_props.map((p) => `prop ${l.id}/${p.id}`),
    ]),
  ];
}

export function supersetProblems(previous: StoryBible, next: StoryBible): string[] {
  const kept = new Set(bibleIds(next));
  const scopes = new Map(next.characters.map((c) => [c.id, c.scope]));
  return [
    ...bibleIds(previous).filter((id) => !kept.has(id)).map((id) => `${id} was removed`),
    ...previous.characters
      .filter((c) => c.scope === "channel" && scopes.get(c.id) === "story")
      .map((c) => `character ${c.id} went from channel to story scope (only story → channel is allowed)`),
  ];
}

const promptHash = (m: MasterItem) => sha256Hex(new TextEncoder().encode(`${m.final_prompt}\n${m.negative_prompt}`)).slice(0, 16);

/** Make story_masters match the bible. A changed prompt drops that master's approval. */
async function syncMasters(db: Db, bible: StoryBible, removeStale: boolean): Promise<void> {
  const items = buildMasterItems(bible);
  const existing = new Map(
    (await db.select().from(storyMasters).where(eq(storyMasters.storyId, bible.story_id))).map((r) => [r.masterKey, r]),
  );
  for (const m of items) {
    const hash = promptHash(m);
    const row = existing.get(m.master_key);
    const values = {
      kind: m.kind,
      label: m.label,
      prompt: m.final_prompt,
      negativePrompt: m.negative_prompt,
      promptParts: m.prompt_parts,
      mustMatch: m.must_match,
      updatedAt: new Date(),
    };
    if (!row) {
      await db.insert(storyMasters).values({ storyId: bible.story_id, masterKey: m.master_key, ...values, status: "missing" });
    } else if (promptHash({ ...m, final_prompt: row.prompt, negative_prompt: row.negativePrompt }) !== hash) {
      await db
        .update(storyMasters)
        .set({ ...values, status: "missing", approvedAssetId: null, approvedAt: null, attempts: 0 })
        .where(and(eq(storyMasters.storyId, bible.story_id), eq(storyMasters.masterKey, m.master_key)));
    } else {
      await db
        .update(storyMasters)
        .set({ label: m.label, promptParts: m.prompt_parts, mustMatch: m.must_match })
        .where(and(eq(storyMasters.storyId, bible.story_id), eq(storyMasters.masterKey, m.master_key)));
    }
  }
  if (removeStale) {
    const keep = new Set(items.map((m) => m.master_key));
    const stale = [...existing.keys()].filter((k) => !keep.has(k));
    if (stale.length) {
      await db.delete(storyMasters).where(and(eq(storyMasters.storyId, bible.story_id), inArray(storyMasters.masterKey, stale)));
    }
  }
}

/** Same bible as stored (ignoring key order and defaults applied on parse)? */
export function sameBible(a: StoryBible, b: StoryBible): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export type SaveStoryOutcome = "created" | "filled" | "updated" | "unchanged";

/**
 * Store a validated story bible. A new story starts at STORY_VALIDATED; an empty folder of the same id gets
 * the bible. Re-pasting the same bible changes nothing. Otherwise the bible is replaced while no episodes
 * exist; afterwards only supersets (additions) are accepted so existing episodes stay valid.
 */
export async function saveStory(
  db: Db,
  bible: StoryBible,
  rawJson: string,
  warnings: unknown[],
): Promise<{ storyId: string; created: boolean; outcome: SaveStoryOutcome }> {
  const existing = await getStory(db, bible.story_id);
  if (existing?.status === "deleted") {
    throw new Error(`Story "${existing.title}" (${existing.id}) is in the trash. Restore it before adding to it.`);
  }
  let outcome: SaveStoryOutcome;
  if (existing?.bible) {
    if (sameBible(existing.bible as StoryBible, bible)) return { storyId: bible.story_id, created: false, outcome: "unchanged" };
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.storyId, bible.story_id));
    if (n > 0) {
      const problems = supersetProblems(existing.bible as StoryBible, bible);
      if (problems.length) {
        throw new Error(
          `This story already has ${n} episode(s), so the new bible may only add things: ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; …" : ""}.`,
        );
      }
    }
    await db
      .update(stories)
      .set({ bible, rawJson, warnings, bibleVersion: sql`${stories.bibleVersion} + 1`, updatedAt: new Date() })
      .where(eq(stories.id, bible.story_id));
    await syncMasters(db, bible, n === 0);
    await refreshStoryStateCache(db, bible.story_id);
    await logEvent(db, { storyId: bible.story_id }, null, "info", "Story bible updated.");
    outcome = "updated";
  } else if (existing) {
    await db
      .update(stories)
      .set({
        state: "STORY_VALIDATED",
        stateDetail: "Story bible validated.",
        description: existing.description || bible.story_description,
        bible,
        rawJson,
        warnings,
        bibleVersion: 1,
        storyState: initialStoryState(bible),
        updatedAt: new Date(),
      })
      .where(eq(stories.id, bible.story_id));
    await syncMasters(db, bible, true);
    await refreshStoryStateCache(db, bible.story_id);
    await logEvent(db, { storyId: bible.story_id }, null, "info", "Story bible added to the folder.");
    outcome = "filled";
  } else {
    await db.insert(stories).values({
      id: bible.story_id,
      title: bible.story_title,
      state: "STORY_VALIDATED",
      stateDetail: "Story bible validated.",
      description: bible.story_description,
      bible,
      rawJson,
      bibleVersion: 1,
      storyState: initialStoryState(bible),
      warnings,
    });
    await syncMasters(db, bible, true);
    await logEvent(db, { storyId: bible.story_id }, null, "info", "Story created from story bible JSON.");
    outcome = "created";
  }
  await registerChannelCast(db, bible);
  await reuseChannelMasters(db, bible.story_id);
  await advanceStory(db, bible.story_id);
  return { storyId: bible.story_id, created: outcome === "created", outcome };
}

export const voiceSampleKey = (speaker: string) => `voice_sample/${speaker}`;

/** Ask the worker to voice a short test line with one speaker's voice (Story page "Test voice"). */
export async function requestVoiceSample(db: Db, storyId: string, speaker: string, text?: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const bible = requireBible(story);
  const { voices } = await storyVoices(db, storyId);
  const voice = voices[speaker];
  if (!voice) throw new Error(`${speaker} has no voice in the story bible.`);
  const name = speaker === NARRATOR ? "the narrator" : (bible.characters.find((c) => c.id === speaker)?.name ?? speaker);
  await createTask(db, {
    storyId,
    kind: "worker",
    type: "voice_sample",
    scope: `${speaker}:${Date.now()}`,
    payload: {
      speaker,
      voice,
      text: (text ?? "").trim().slice(0, 300) || `This is a voice test for ${name}. The quick brown fox jumps over the lazy dog.`,
      asset_key: voiceSampleKey(speaker),
      audio: bible.defaults.audio,
    },
    priority: 30,
    maxAttempts: 2,
    timeoutMinutes: 10,
  });
  await logEvent(db, { storyId }, null, "info", `Voice test requested for ${name}.`);
}

/** Make a story character part of the channel cast (story → channel only; never back). */
export async function promoteCharacter(db: Db, storyId: string, characterId: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const bible = structuredClone(requireBible(story));
  const c = bible.characters.find((x) => x.id === characterId);
  if (!c) throw new Error(`Unknown character ${characterId}.`);
  if (c.scope === "channel") throw new Error(`${c.name} is already in the channel cast.`);
  const registry = await loadCastRegistry(db);
  const taken = registry.get(characterId);
  if (taken) throw new Error(`The channel cast already has a "${characterId}" (from story "${taken.origin_story_id}").`);
  c.scope = "channel";
  await db.update(stories).set({ bible, bibleVersion: sql`${stories.bibleVersion} + 1`, updatedAt: new Date() }).where(eq(stories.id, storyId));
  await registerChannelCast(db, bible);
  const approved = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "approved")));
  for (const m of approved) if (m.approvedAssetId) await recordChannelMaster(db, storyId, m.masterKey, m.approvedAssetId);
  await logEvent(db, { storyId }, null, "info", `${c.name} promoted to the channel cast.`);
}

/**
 * An accepted episode's bible_additions become part of the story (they are append-only), so later episodes
 * can use them and their masters are made like any other.
 */
export async function mergeBibleAdditions(db: Db, storyId: string, additions: BibleAdditions | undefined, episodeNumber: number): Promise<boolean> {
  if (!additions) return false;
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const before = requireBible(story);
  const merged = applyBibleAdditions(before, additions);
  if (JSON.stringify(merged) === JSON.stringify(before)) return false;
  await db
    .update(stories)
    .set({ bible: merged, bibleVersion: sql`${stories.bibleVersion} + 1`, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
  await syncMasters(db, merged, false);
  await registerChannelCast(db, merged);
  await reuseChannelMasters(db, storyId);
  await logEvent(db, { storyId }, null, "info", `Bible additions from episode ${episodeNumber} merged into the story.`);
  await advanceStory(db, storyId);
  return true;
}

const GROUP_TASK = "generate_character_group_master" as const;
const MASTER_TASK_TYPES = ["generate_location_master", GROUP_TASK] as const;
type MasterTaskType = (typeof MASTER_TASK_TYPES)[number];
const taskTypeFor = (r: { kind: string }): MasterTaskType => (r.kind === "group" ? GROUP_TASK : "generate_location_master");

function masterTaskPayload(story: StoryRow, rows: StoryMasterRow[], fixNote?: string) {
  const bible = requireBible(story);
  return {
    story_id: story.id,
    story_title: story.title,
    purpose: rows.every((r) => r.kind === "group") ? "character_group_masters" : "location_masters",
    style_bible: {
      global_style_prompt: bible.style_bible.global_style_prompt,
      negative_prompt: bible.style_bible.negative_prompt,
      aspect_ratio: bible.style_bible.aspect_ratio,
    },
    items: rows.map((r) => ({
      master_key: r.masterKey,
      kind: r.kind,
      label: r.label,
      segment_id: "master",
      asset_key: masterAssetKey(r.masterKey),
      final_prompt: r.prompt,
      negative_prompt: r.negativePrompt,
      must_match: r.mustMatch,
      aspect_ratio: bible.style_bible.aspect_ratio,
      output_filename: `${r.masterKey.replaceAll("/", "__")}.png`,
      reference_image_urls: [],
      ...(fixNote ? { fix_note: fixNote } : {}),
    })),
  };
}

function trigger(bible: StoryBible, type = "generate_location_master") {
  return (
    bible.automation.bot_triggers.find((t) => t.bot_task_type === type) ??
    bible.automation.bot_triggers.find((t) => t.bot_task_type === "generate_location_master")
  );
}

/**
 * Masters wait in the queue below every episode task (images 10, thumbnail 9, upload 8), so the bot finishes
 * episodes before making masters for later ones. Manual regenerations keep their own higher priority.
 */
export const MASTER_PRIORITY = 6;

const masterKeysOf = (t: TaskRow) => ((t.payload as { items?: { master_key: string }[] }).items ?? []).map((i) => i.master_key);

/**
 * Masters the story's episodes need, each mapped to the first episode that needs it. Only active versions that
 * have been started and are not published count; masters no such episode uses are not generated.
 */
export async function masterDemand(db: Db, storyId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ episode: projects.episode, number: projects.episodeNumber })
    .from(episodes)
    .innerJoin(projects, eq(projects.id, episodes.activeVersionId))
    .where(and(eq(episodes.storyId, storyId), eq(projects.archived, false), isNull(projects.publishedAt), ne(projects.state, "DRAFT")));
  const demand = new Map<string, number>();
  for (const r of rows.sort((a, b) => a.number - b.number)) {
    for (const key of episodeMasterKeys(r.episode as Episode)) if (!demand.has(key)) demand.set(key, r.number);
  }
  return demand;
}

/**
 * Queue the masters that started episodes need and are not yet requested, earliest episode first. Queued
 * batches nobody needs any more (or queued at the old priority) are withdrawn and re-batched; a batch the bot
 * is already working on is left alone. Does not advance episodes, so the episode state machine may call it.
 * Returns whether any batch was withdrawn or queued.
 */
export async function requestNeededMasters(db: Db, storyId: string): Promise<boolean> {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`SELECT id FROM stories WHERE id = ${storyId} FOR UPDATE`);
    const story = await getStory(tx, storyId);
    if (!story || !story.bible || story.status === "deleted" || !mastersGateOn(story.bible as StoryBible)) return false;
    const bible = story.bible as StoryBible;
    const demand = await masterDemand(tx, storyId);
    let changed = false;

    let storyTasks = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.storyId, storyId), inArray(tasks.type, MASTER_TASK_TYPES)));
    const stale = storyTasks.filter(
      (t) => t.status === "queued" && !t.scope.startsWith("regen:") && (t.priority !== MASTER_PRIORITY || masterKeysOf(t).some((k) => !demand.has(k))),
    );
    if (stale.length) {
      const withdrawn = await tx
        .update(tasks)
        .set({ status: "cancelled", error: "Withdrawn: masters are now made only when an episode needs them.", updatedAt: new Date() })
        .where(and(inArray(tasks.id, stale.map((t) => t.id)), eq(tasks.status, "queued")))
        .returning();
      const keys = withdrawn.flatMap(masterKeysOf);
      if (keys.length) {
        await tx
          .update(storyMasters)
          .set({ status: "missing", attempts: sql`greatest(${storyMasters.attempts} - 1, 0)`, updatedAt: new Date() })
          .where(and(eq(storyMasters.storyId, storyId), inArray(storyMasters.masterKey, keys), eq(storyMasters.status, "requested")));
      }
      if (withdrawn.length) {
        await logEvent(tx, { storyId }, null, "info", `Withdrew ${withdrawn.length} queued master batch(es); masters are re-queued in episode order as episodes need them.`);
      }
      if (withdrawn.length) changed = true;
      const gone = new Set(withdrawn.map((t) => t.id));
      storyTasks = storyTasks.map((t) => (gone.has(t.id) ? { ...t, status: "cancelled" } : t));
    }

    const activeKeys = new Set(storyTasks.filter(isActive).flatMap(masterKeysOf));
    let rows = await tx.select().from(storyMasters).where(eq(storyMasters.storyId, storyId));

    // A request whose task ended without an upload goes back to "missing".
    const orphaned = rows.filter((r) => r.status === "requested" && !activeKeys.has(r.masterKey)).map((r) => r.masterKey);
    if (orphaned.length) {
      await tx
        .update(storyMasters)
        .set({ status: "missing" })
        .where(and(eq(storyMasters.storyId, storyId), inArray(storyMasters.masterKey, orphaned)));
      rows = rows.map((r) => (orphaned.includes(r.masterKey) ? { ...r, status: "missing" } : r));
    }

    const toRequest = rows
      .filter((r) => r.status === "missing" && r.attempts < MAX_MASTER_ATTEMPTS && !activeKeys.has(r.masterKey) && demand.has(r.masterKey))
      .sort((a, b) => demand.get(a.masterKey)! - demand.get(b.masterKey)! || a.masterKey.localeCompare(b.masterKey));
    let batchNo = storyTasks.length;
    for (const type of MASTER_TASK_TYPES) {
      const ofType = toRequest.filter((r) => taskTypeFor(r) === type);
      const t = trigger(bible, type);
      const size = t?.batch_size ?? 8;
      for (let i = 0; i < ofType.length; i += size) {
        const batch = ofType.slice(i, i + size);
        batchNo++;
        changed = true;
        await createTask(tx, {
          storyId,
          kind: "bot",
          type,
          scope: `${type === GROUP_TASK ? "groups" : "masters"}:${String(batchNo).padStart(2, "0")}`,
          payload: masterTaskPayload(story, batch),
          priority: MASTER_PRIORITY,
          maxAttempts: t?.retry.max_attempts ?? 3,
          backoffSec: t?.retry.backoff_sec ?? 60,
          timeoutMinutes: t?.timeout_minutes ?? 180,
        });
        await tx
          .update(storyMasters)
          .set({ status: "requested", attempts: sql`${storyMasters.attempts} + 1`, updatedAt: new Date() })
          .where(and(eq(storyMasters.storyId, storyId), inArray(storyMasters.masterKey, batch.map((r) => r.masterKey))));
      }
    }
    return changed;
  });
}

/** Idempotent: queue the masters episodes need, recompute the story state, and wake episodes waiting on masters. */
export async function advanceStory(db: Db, storyId: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story || !story.bible || story.status === "deleted") return;
  const bible = story.bible as StoryBible;

  if (!mastersGateOn(bible)) {
    await db
      .update(stories)
      .set({ state: "MASTERS_APPROVED", stateDetail: "Location masters are off for this story (approval_gates.location_masters = false)." })
      .where(eq(stories.id, storyId));
    await wakeEpisodes(db, storyId);
    return;
  }

  await requestNeededMasters(db, storyId);
  await refreshMastersState(db, story);
  await wakeEpisodes(db, storyId);
}

/** Recompute the story's masters state and summary line. */
export async function refreshMastersState(db: Db, story: StoryRow): Promise<void> {
  const storyId = story.id;
  const owner: Owner = { storyId };
  const demand = await masterDemand(db, storyId);
  const rows = await db.select().from(storyMasters).where(eq(storyMasters.storyId, storyId));

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const approved = count("approved");
  const generated = count("generated");
  const requested = count("requested");
  const exhausted = rows.filter((r) => r.status === "missing" && r.attempts >= MAX_MASTER_ATTEMPTS);
  const notNeeded = rows.filter((r) => r.status === "missing" && !demand.has(r.masterKey)).length;
  const neededOpen = rows.some((r) => demand.has(r.masterKey) && r.status !== "approved");
  let state: StoryStateName;
  if (requested > 0) state = "LOCATION_MASTERS_REQUESTED";
  else if (generated > 0) state = "MASTERS_REVIEW";
  else if (neededOpen) state = "STORY_VALIDATED";
  else state = "MASTERS_APPROVED";
  const detail = [
    `${approved}/${rows.length} masters approved`,
    generated ? `${generated} awaiting review` : "",
    requested ? `${requested} being generated` : "",
    notNeeded ? `${notNeeded} not needed by any episode yet` : "",
    exhausted.length ? `${exhausted.length} failed after ${MAX_MASTER_ATTEMPTS} attempts (regenerate to retry)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (state !== story.state) await logEvent(db, owner, null, "info", `Story state ${story.state} → ${state}.`);
  await db.update(stories).set({ state, stateDetail: detail, updatedAt: new Date() }).where(eq(stories.id, storyId));
}

/** Re-run the state machine of every episode that may be waiting on this story's masters. */
async function wakeEpisodes(db: Db, storyId: string) {
  const { advance } = await import("./advance");
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.storyId, storyId), eq(projects.archived, false), inArray(projects.state, ["WAITING_MASTERS", "FAILED"])));
  for (const r of rows) await advance(db, r.id);
}

export async function onStoryTaskCompleted(db: Db, task: TaskRow): Promise<void> {
  if (!(MASTER_TASK_TYPES as readonly string[]).includes(task.type) || !task.storyId) return;
  const uploaded = await db
    .select()
    .from(assets)
    .where(and(eq(assets.taskId, task.id), eq(assets.status, "ready")));
  const keys = [...new Set(uploaded.map((a) => a.assetKey.replace(/^master\//, "")))];
  if (keys.length) {
    await db
      .update(storyMasters)
      .set({ status: "generated", approvedAssetId: null, approvedAt: null, updatedAt: new Date() })
      .where(and(eq(storyMasters.storyId, task.storyId), inArray(storyMasters.masterKey, keys), inArray(storyMasters.status, ["requested", "missing"])));
  }
}

/** Candidates for one master, newest first. */
export async function masterCandidates(db: Db, storyId: string, masterKey: string) {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.storyId, storyId), eq(assets.assetKey, masterAssetKey(masterKey)), eq(assets.status, "ready")))
    .orderBy(desc(assets.createdAt));
}

export async function approveMaster(db: Db, storyId: string, masterKey: string, assetId?: string): Promise<void> {
  const candidates = await masterCandidates(db, storyId, masterKey);
  const chosen = assetId ? candidates.find((c) => c.id === assetId) : candidates[0];
  if (!chosen) throw new Error(`No uploaded image for ${masterKey} yet.`);
  await db
    .update(storyMasters)
    .set({ status: "approved", approvedAssetId: chosen.id, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, masterKey)));
  await recordChannelMaster(db, storyId, masterKey, chosen.id);
  await logEvent(db, { storyId }, null, "info", `Approved master ${masterKey}.`);
  await advanceStory(db, storyId);
}

export async function approveAllGenerated(db: Db, storyId: string): Promise<number> {
  const rows = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "generated")));
  let n = 0;
  for (const r of rows) {
    const [latest] = await masterCandidates(db, storyId, r.masterKey);
    if (!latest) continue;
    await db
      .update(storyMasters)
      .set({ status: "approved", approvedAssetId: latest.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, r.masterKey)));
    await recordChannelMaster(db, storyId, r.masterKey, latest.id);
    n++;
  }
  if (n) await logEvent(db, { storyId }, null, "info", `Approved ${n} master(s).`);
  await advanceStory(db, storyId);
  return n;
}

/** Drop the current approval and ask the bot for a new candidate. */
/** `fixNote` tells the bot what was wrong with the previous picture (e.g. reported by an image task). */
export async function regenerateMaster(db: Db, storyId: string, masterKey: string, fixNote?: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const [row] = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, masterKey)));
  if (!row) throw new Error(`Unknown master ${masterKey}.`);
  const type = taskTypeFor(row);
  const t = trigger(requireBible(story), type);
  await createTask(db, {
    storyId,
    kind: "bot",
    type,
    scope: `regen:${masterKey}:${Date.now()}`,
    payload: masterTaskPayload(story, [row], fixNote),
    priority: 20,
    maxAttempts: t?.retry.max_attempts ?? 3,
    timeoutMinutes: t?.timeout_minutes ?? 60,
  });
  await db
    .update(storyMasters)
    .set({ status: "requested", approvedAssetId: null, approvedAt: null, attempts: 1, updatedAt: new Date() })
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, masterKey)));
  await logEvent(db, { storyId }, null, "info", `Regenerating master ${masterKey}.${fixNote ? ` Reason: ${fixNote}` : ""}`);
  await advanceStory(db, storyId);
}

/**
 * Make sure an episode version's end state is recorded as its snapshot and refresh the story state cache.
 * Snapshots are stored when an episode is accepted (2.3); this also covers versions stored before that.
 */
export async function commitStoryState(db: Db, projectId: string): Promise<StoryStateSnapshot | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.storyId) return null;
  const end = (project.outputs as { story_state_end?: StoryStateSnapshot }).story_state_end;
  if (!end) return null;
  await recordSnapshot(db, { projectId, storyId: project.storyId, episodeNumber: project.episodeNumber, version: project.version }, end);
  await refreshStoryStateCache(db, project.storyId);
  await db
    .update(projects)
    .set({ outputs: { ...(project.outputs as object), story_state_committed_at: new Date().toISOString() } })
    .where(eq(projects.id, projectId));
  await logEvent(db, { storyId: project.storyId }, null, "info", `Story state recorded after episode ${project.episodeNumber} (v${project.version}).`);
  return end;
}

/** Permanently removes a story folder: every episode version with its files, then the story's own files and rows. */
export async function deleteStory(db: Db, storyId: string): Promise<{ filesDeleted: number }> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const { deleteProject } = await import("./actions");
  let filesDeleted = 0;
  await db.update(episodes).set({ activeVersionId: null }).where(eq(episodes.storyId, storyId));
  const versions = await db.select({ id: projects.id }).from(projects).where(eq(projects.storyId, storyId));
  for (const v of versions) filesDeleted += (await deleteProject(db, v.id)).filesDeleted;
  await db
    .update(tasks)
    .set({ status: "cancelled" })
    .where(and(eq(tasks.storyId, storyId), inArray(tasks.status, ["queued", "leased"])));
  filesDeleted += await getStorage().deletePrefix(storyObjectPrefix(storyId));
  await db.delete(stories).where(eq(stories.id, storyId));
  return { filesDeleted };
}

export interface BadMaster {
  master_key: string;
  reason: string;
}

/**
 * An image task reports that an approved master itself breaks the rules (e.g. readable letters),
 * so no image built on it can pass. Instead of failing the episode, the master is sent back for
 * regeneration with the reason, and the task's images wait for the new master's approval.
 * Returns the masters that were sent back, or null when the report doesn't apply (normal failure).
 */
export async function parkOnBadMasters(db: Db, task: TaskRow, leaseId: string, reason: string, bad: BadMaster[]): Promise<string[] | null> {
  if (task.type !== "generate_images" || !task.projectId) return null;
  const [project] = await db.select({ storyId: projects.storyId }).from(projects).where(eq(projects.id, task.projectId));
  if (!project?.storyId) return null;
  const items = ((task.payload as { items?: { segment_id: string; master_keys?: string[] }[] }).items ?? []);
  const used = new Set(items.flatMap((i) => i.master_keys ?? []));
  const reported = [...new Map(bad.filter((b) => used.has(b.master_key)).map((b) => [b.master_key, b])).values()];
  if (!reported.length) return null;
  const rows = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, project.storyId), inArray(storyMasters.masterKey, reported.map((b) => b.master_key))));
  const known = new Map(rows.map((r) => [r.masterKey, r]));
  const sentBack = reported.filter((b) => known.has(b.master_key));
  if (!sentBack.length) return null;

  const [parked] = await db
    .update(tasks)
    .set({ status: "superseded", error: reason.slice(0, 4000), leaseId: null, leaseExpiresAt: null, completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.leaseId, leaseId), eq(tasks.status, "leased")))
    .returning();
  if (!parked) return null;
  for (const b of sentBack) {
    const status = known.get(b.master_key)!.status;
    // Anything else means it is already being redone (another task reported it first): just wait for it.
    if (status === "approved" || status === "generated") await regenerateMaster(db, project.storyId, b.master_key, b.reason.trim().slice(0, 1000));
  }
  const segmentIds = items.map((i) => i.segment_id);
  if (segmentIds.length) {
    await db.update(segments).set({ imageAttempts: 0 }).where(and(eq(segments.projectId, task.projectId), inArray(segments.segmentId, segmentIds)));
  }
  await logEvent(
    db,
    task.projectId,
    task.id,
    "warning",
    `${segmentIds.join(", ")} wait for master${sentBack.length === 1 ? "" : "s"} ${sentBack.map((b) => b.master_key).join(", ")} to be redone and approved: ${sentBack
      .map((b) => b.reason)
      .join(" / ")
      .slice(0, 800)}`,
  );
  return sentBack.map((b) => b.master_key);
}
