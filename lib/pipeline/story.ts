import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { sha256Hex } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { assets, projects, stories, storyMasters, tasks, type StoryMasterRow, type StoryRow, type TaskRow } from "@/lib/db/schema";
import { initialStoryState, type StoryState, type StoryStateSnapshot } from "@/lib/episode/continuity";
import { buildMasterItems, type MasterItem } from "@/lib/episode/prompt";
import type { StoryBible } from "@/lib/episode/schema";
import type { StoryContext } from "@/lib/episode/validate";
import { createTask, logEvent, type Owner } from "@/lib/queue";
import { getStorage, storyObjectPrefix } from "@/lib/storage";

export const STORY_STATES = ["STORY_VALIDATED", "LOCATION_MASTERS_REQUESTED", "MASTERS_REVIEW", "MASTERS_APPROVED"] as const;
export type StoryStateName = (typeof STORY_STATES)[number];

const MAX_MASTER_ATTEMPTS = 3;
const isActive = (t: TaskRow) => t.status === "queued" || t.status === "leased";

export const masterAssetKey = (masterKey: string) => `master/${masterKey}`;

export function mastersGateOn(bible: StoryBible): boolean {
  return bible.automation.approval_gates.location_masters;
}

export async function getStory(db: Db, storyId: string): Promise<StoryRow | null> {
  const [row] = await db.select().from(stories).where(eq(stories.id, storyId));
  return row ?? null;
}

/** Everything an episode of this story is validated against. */
export async function loadStoryContext(db: Db, storyId: string): Promise<StoryContext | null> {
  const story = await getStory(db, storyId);
  if (!story) return null;
  const bible = story.bible as StoryBible;
  const approved = await db
    .select({ key: storyMasters.masterKey })
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "approved")));
  return {
    bible,
    state: story.storyState as StoryState,
    approvedMasters: new Set(approved.map((r) => r.key)),
    mastersGate: mastersGateOn(bible),
  };
}

/** Ids a later bible must keep once episodes exist (append-only, like bible_additions). */
function bibleIds(b: StoryBible): string[] {
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
  return bibleIds(previous).filter((id) => !kept.has(id)).map((id) => `${id} was removed`);
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

/**
 * Store a validated story bible. A new story starts at STORY_VALIDATED. Re-pasting replaces it while no
 * episodes exist; afterwards only supersets are accepted so existing episodes stay valid.
 */
export async function saveStory(
  db: Db,
  bible: StoryBible,
  rawJson: string,
  warnings: unknown[],
): Promise<{ storyId: string; created: boolean }> {
  const existing = await getStory(db, bible.story_id);
  if (existing) {
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
    const state = existing.storyState as StoryState;
    await db
      .update(stories)
      .set({ title: bible.story_title, bible, rawJson, warnings, updatedAt: new Date(), storyState: state })
      .where(eq(stories.id, bible.story_id));
    await syncMasters(db, bible, n === 0);
    await logEvent(db, { storyId: bible.story_id }, null, "info", "Story bible updated.");
  } else {
    await db.insert(stories).values({
      id: bible.story_id,
      title: bible.story_title,
      state: "STORY_VALIDATED",
      stateDetail: "Story bible validated.",
      bible,
      rawJson,
      storyState: initialStoryState(bible),
      warnings,
    });
    await syncMasters(db, bible, true);
    await logEvent(db, { storyId: bible.story_id }, null, "info", "Story created from story bible JSON.");
  }
  await advanceStory(db, bible.story_id);
  return { storyId: bible.story_id, created: !existing };
}

function masterTaskPayload(story: StoryRow, rows: StoryMasterRow[]) {
  const bible = story.bible as StoryBible;
  return {
    story_id: story.id,
    story_title: story.title,
    purpose: "location_masters",
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
    })),
  };
}

function trigger(bible: StoryBible) {
  return bible.automation.bot_triggers.find((t) => t.bot_task_type === "generate_location_master");
}

/** Idempotent: queue missing masters, recompute the story state, and wake episodes waiting on masters. */
export async function advanceStory(db: Db, storyId: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story || story.archived) return;
  const bible = story.bible as StoryBible;
  const owner: Owner = { storyId };

  if (!mastersGateOn(bible)) {
    await db
      .update(stories)
      .set({ state: "MASTERS_APPROVED", stateDetail: "Location masters are off for this story (approval_gates.location_masters = false)." })
      .where(eq(stories.id, storyId));
    await wakeEpisodes(db, storyId);
    return;
  }

  const storyTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.storyId, storyId), eq(tasks.type, "generate_location_master")));
  const activeKeys = new Set(
    storyTasks.filter(isActive).flatMap((t) => ((t.payload as { items?: { master_key: string }[] }).items ?? []).map((i) => i.master_key)),
  );
  let rows = await db.select().from(storyMasters).where(eq(storyMasters.storyId, storyId));

  // A request whose task ended without an upload goes back to "missing".
  const orphaned = rows.filter((r) => r.status === "requested" && !activeKeys.has(r.masterKey)).map((r) => r.masterKey);
  if (orphaned.length) {
    await db
      .update(storyMasters)
      .set({ status: "missing" })
      .where(and(eq(storyMasters.storyId, storyId), inArray(storyMasters.masterKey, orphaned)));
    rows = rows.map((r) => (orphaned.includes(r.masterKey) ? { ...r, status: "missing" } : r));
  }

  const toRequest = rows.filter((r) => r.status === "missing" && r.attempts < MAX_MASTER_ATTEMPTS && !activeKeys.has(r.masterKey));
  const exhausted = rows.filter((r) => r.status === "missing" && r.attempts >= MAX_MASTER_ATTEMPTS);
  if (toRequest.length) {
    const t = trigger(bible);
    const size = t?.batch_size ?? 8;
    const batchNo = storyTasks.length;
    for (let i = 0; i < toRequest.length; i += size) {
      const batch = toRequest.slice(i, i + size);
      await createTask(db, {
        storyId,
        kind: "bot",
        type: "generate_location_master",
        scope: `masters:${String(batchNo + i / size + 1).padStart(2, "0")}`,
        payload: masterTaskPayload(story, batch),
        priority: 11,
        maxAttempts: t?.retry.max_attempts ?? 3,
        backoffSec: t?.retry.backoff_sec ?? 60,
        timeoutMinutes: t?.timeout_minutes ?? 180,
      });
      await db
        .update(storyMasters)
        .set({ status: "requested", attempts: sql`${storyMasters.attempts} + 1`, updatedAt: new Date() })
        .where(and(eq(storyMasters.storyId, storyId), inArray(storyMasters.masterKey, batch.map((r) => r.masterKey))));
    }
    rows = await db.select().from(storyMasters).where(eq(storyMasters.storyId, storyId));
  }

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const approved = count("approved");
  const generated = count("generated");
  const requested = count("requested");
  let state: StoryStateName;
  if (rows.length && approved === rows.length) state = "MASTERS_APPROVED";
  else if (requested > 0) state = "LOCATION_MASTERS_REQUESTED";
  else if (generated > 0) state = "MASTERS_REVIEW";
  else state = rows.length ? "STORY_VALIDATED" : "MASTERS_APPROVED";
  const detail = [
    `${approved}/${rows.length} masters approved`,
    generated ? `${generated} awaiting review` : "",
    requested ? `${requested} being generated` : "",
    exhausted.length ? `${exhausted.length} failed after ${MAX_MASTER_ATTEMPTS} attempts (regenerate to retry)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (state !== story.state) await logEvent(db, owner, null, "info", `Story state ${story.state} → ${state}.`);
  await db.update(stories).set({ state, stateDetail: detail, updatedAt: new Date() }).where(eq(stories.id, storyId));
  await wakeEpisodes(db, storyId);
}

/** Re-run the state machine of every episode that may be waiting on this story's masters. */
async function wakeEpisodes(db: Db, storyId: string) {
  const { advance } = await import("./advance");
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.storyId, storyId), eq(projects.archived, false), eq(projects.state, "WAITING_MASTERS")));
  for (const r of rows) await advance(db, r.id);
}

export async function onStoryTaskCompleted(db: Db, task: TaskRow): Promise<void> {
  if (task.type !== "generate_location_master" || !task.storyId) return;
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
    n++;
  }
  if (n) await logEvent(db, { storyId }, null, "info", `Approved ${n} master(s).`);
  await advanceStory(db, storyId);
  return n;
}

/** Drop the current approval and ask the bot for a new candidate. */
export async function regenerateMaster(db: Db, storyId: string, masterKey: string): Promise<void> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const [row] = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, masterKey)));
  if (!row) throw new Error(`Unknown master ${masterKey}.`);
  const t = trigger(story.bible as StoryBible);
  await createTask(db, {
    storyId,
    kind: "bot",
    type: "generate_location_master",
    scope: `regen:${masterKey}:${Date.now()}`,
    payload: masterTaskPayload(story, [row]),
    priority: 20,
    maxAttempts: t?.retry.max_attempts ?? 3,
    timeoutMinutes: t?.timeout_minutes ?? 60,
  });
  await db
    .update(storyMasters)
    .set({ status: "requested", approvedAssetId: null, approvedAt: null, attempts: 1, updatedAt: new Date() })
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, masterKey)));
  await logEvent(db, { storyId }, null, "info", `Regenerating master ${masterKey}.`);
  await advanceStory(db, storyId);
}

/**
 * Record where the story stands after an episode, so the next episode is validated against it.
 * Runs automatically when an episode is published; the Story page can also commit it by hand.
 */
export async function commitStoryState(db: Db, projectId: string): Promise<StoryStateSnapshot | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project?.storyId) return null;
  const end = (project.outputs as { story_state_end?: StoryStateSnapshot }).story_state_end;
  if (!end) return null;
  const story = await getStory(db, project.storyId);
  if (!story) return null;
  const state = structuredClone(story.storyState as StoryState);
  state.by_episode[String(end.after_episode)] = end;
  state.committed_through_episode = Math.max(state.committed_through_episode, end.after_episode);
  const latest = Object.values(state.by_episode).sort((a, b) => b.after_episode - a.after_episode)[0];
  state.current = latest ?? state.current;
  await db.update(stories).set({ storyState: state, updatedAt: new Date() }).where(eq(stories.id, project.storyId));
  await db
    .update(projects)
    .set({ outputs: { ...(project.outputs as object), story_state_committed_at: new Date().toISOString() } })
    .where(eq(projects.id, projectId));
  await logEvent(db, { storyId: project.storyId }, null, "info", `Story state committed after episode ${end.after_episode}.`);
  return end;
}

export async function deleteStory(db: Db, storyId: string): Promise<{ filesDeleted: number }> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(projects).where(eq(projects.storyId, storyId));
  if (n > 0) throw new Error(`Delete its ${n} episode(s) first.`);
  await db
    .update(tasks)
    .set({ status: "cancelled" })
    .where(and(eq(tasks.storyId, storyId), inArray(tasks.status, ["queued", "leased"])));
  const filesDeleted = await getStorage().deletePrefix(storyObjectPrefix(storyId));
  await db.delete(stories).where(eq(stories.id, storyId));
  return { filesDeleted };
}
