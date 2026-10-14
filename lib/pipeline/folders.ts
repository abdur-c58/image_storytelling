import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { assets, episodes, projects, stories, tasks, type AssetRow, type ProjectRow, type StoryRow } from "@/lib/db/schema";
import { normalizeEpisodeHeader, readHeader } from "@/lib/episode/header";
import { isStorySlug, UNSORTED_STORY_ID } from "@/lib/episode/naming";
import { statusBucket, type StatusBucket } from "@/lib/episode/status";
import { EpisodeDocSchema, StoryDefaultsSchema, type EpisodeDoc, type StoryBible } from "@/lib/episode/schema";
import { detectDocType, parseJsonText, type DocType, type ValidationIssue } from "@/lib/episode/validate";
import { logEvent } from "@/lib/queue";
import { archiveProject, deleteProject } from "./actions";
import { advance } from "./advance";
import { applySeriesNav, type SeriesNav } from "./description";
import { ingestDocument, validateWithStore } from "./ingest";
import { revalidateLaterEpisodes } from "./revalidate";
import { refreshStoryStateCache } from "./snapshots";
import { bibleIds, deleteStory, getStory, sameBible, supersetProblems } from "./story";

export const TRASH_DAYS = 30;

/** Whole days left before a trashed story is purged. */
export function daysUntilPurge(deletedAt: Date | null, now = new Date()): number | null {
  if (!deletedAt) return null;
  return Math.max(0, TRASH_DAYS - Math.floor((now.getTime() - deletedAt.getTime()) / 86_400_000));
}

// ── Story folders ─────────────────────────────────────────────────────────

async function requireStory(db: Db, storyId: string): Promise<StoryRow> {
  const story = await getStory(db, storyId);
  if (!story) throw new Error("Story not found.");
  return story;
}

/** "New story": a named, empty folder. Episodes can be added once its bible is pasted. */
export async function createEmptyStory(db: Db, input: { title: string; slug: string; description?: string }): Promise<string> {
  const title = input.title.trim();
  const slug = input.slug.trim();
  if (!title) throw new Error("Give the story a name.");
  if (title.length > 200) throw new Error("The name is longer than 200 characters.");
  if (!isStorySlug(slug)) throw new Error("The id may use lowercase letters, digits, '-' and '_' (up to 64), starting with a letter or digit.");
  const existing = await getStory(db, slug);
  if (existing) {
    throw new Error(
      existing.status === "deleted"
        ? `A story with the id "${slug}" is in the trash. Restore it, or pick another id.`
        : `A story with the id "${slug}" already exists.`,
    );
  }
  await db.insert(stories).values({
    id: slug,
    title,
    description: (input.description ?? "").trim().slice(0, 2000),
    state: "NO_BIBLE",
    stateDetail: "Add the story bible first.",
  });
  await logEvent(db, { storyId: slug }, null, "info", `Story folder "${title}" created.`);
  return slug;
}

export async function renameStory(db: Db, storyId: string, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean) throw new Error("The title must not be empty.");
  if (clean.length > 200) throw new Error("The title is longer than 200 characters.");
  const story = await requireStory(db, storyId);
  if (story.title === clean) return;
  await db.update(stories).set({ title: clean, updatedAt: new Date() }).where(eq(stories.id, storyId));
  await logEvent(db, { storyId }, null, "info", `Story renamed from "${story.title}" to "${clean}" (the id stays ${storyId}).`);
}

const DEFAULT_BLOCKS = ["voice", "audio", "render", "crop_policy", "structure"] as const;

/** Partial story defaults set on the Settings tab; checked by merging them into the bible's defaults. */
export function checkDefaultsOverride(bible: StoryBible | null, override: unknown): Record<string, Record<string, unknown>> {
  if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("Defaults override must be a JSON object.");
  const o = override as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (!(DEFAULT_BLOCKS as readonly string[]).includes(k)) throw new Error(`Unknown defaults block "${k}" (use ${DEFAULT_BLOCKS.join(", ")}).`);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`"${k}" must be an object.`);
  }
  const base = (bible?.defaults ?? StoryDefaultsSchema.parse({})) as Record<string, unknown>;
  const merged = Object.fromEntries(DEFAULT_BLOCKS.map((k) => [k, { ...(base[k] as object), ...((o[k] as object) ?? {}) }]));
  const parsed = StoryDefaultsSchema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue.path.join(".")}: ${issue.message}`);
  }
  return o as Record<string, Record<string, unknown>>;
}

export async function updateStorySettings(
  db: Db,
  storyId: string,
  input: { description?: string; defaultsOverride?: unknown },
): Promise<void> {
  const story = await requireStory(db, storyId);
  const set: Partial<typeof stories.$inferInsert> = { updatedAt: new Date() };
  if (input.description !== undefined) set.description = input.description.trim().slice(0, 2000);
  if (input.defaultsOverride !== undefined) set.defaultsOverride = checkDefaultsOverride(story.bible as StoryBible | null, input.defaultsOverride);
  await db.update(stories).set(set).where(eq(stories.id, storyId));
  if (input.defaultsOverride !== undefined) {
    await logEvent(db, { storyId }, null, "info", "Story defaults override saved; it applies to episodes added from now on.");
  }
}

export async function setStoryArchived(db: Db, storyId: string, archived: boolean): Promise<void> {
  const story = await requireStory(db, storyId);
  if (story.status === "deleted") throw new Error("Restore the story from the trash first.");
  await db.update(stories).set({ status: archived ? "archived" : "active", updatedAt: new Date() }).where(eq(stories.id, storyId));
  await logEvent(db, { storyId }, null, "info", archived ? "Story archived." : "Story unarchived.");
}

/**
 * Move a story to the trash (restorable for TRASH_DAYS days). Its queued and running bot/worker tasks are
 * cancelled and every episode version is halted; nothing is deleted until the purge.
 */
export async function softDeleteStory(db: Db, storyId: string, typedTitle: string): Promise<{ cancelled: number }> {
  const story = await requireStory(db, storyId);
  if (typedTitle.trim() !== story.title.trim()) throw new Error("The story name you typed doesn't match.");
  if (story.status === "deleted") return { cancelled: 0 };
  const versionIds = (await db.select({ id: projects.id }).from(projects).where(eq(projects.storyId, storyId))).map((r) => r.id);
  let cancelled = 0;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const owned = versionIds.length
      ? await tx
          .update(tasks)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(inArray(tasks.projectId, versionIds), inArray(tasks.status, ["queued", "leased"])))
          .returning({ id: tasks.id })
      : [];
    const storyTasks = await tx
      .update(tasks)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(tasks.storyId, storyId), inArray(tasks.status, ["queued", "leased"])))
      .returning({ id: tasks.id });
    cancelled = owned.length + storyTasks.length;
    if (versionIds.length) await tx.update(projects).set({ archived: true }).where(inArray(projects.id, versionIds));
    await tx.update(stories).set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() }).where(eq(stories.id, storyId));
  });
  await logEvent(db, { storyId }, null, "warning", `Story moved to the trash; ${cancelled} queued or running task(s) cancelled. Restorable for ${TRASH_DAYS} days.`);
  return { cancelled };
}

/** Bring a story back from the trash. Active versions resume where they stopped. */
export async function restoreStory(db: Db, storyId: string): Promise<void> {
  const story = await requireStory(db, storyId);
  if (story.status !== "deleted") return;
  const active = await db
    .select({ id: episodes.activeVersionId })
    .from(episodes)
    .where(and(eq(episodes.storyId, storyId), isNotNull(episodes.activeVersionId)));
  const ids = active.map((r) => r.id!);
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.update(stories).set({ status: "active", deletedAt: null, updatedAt: new Date() }).where(eq(stories.id, storyId));
    if (ids.length) await tx.update(projects).set({ archived: false }).where(inArray(projects.id, ids));
  });
  await logEvent(db, { storyId }, null, "info", "Story restored from the trash.");
  const { advanceStory } = await import("./story");
  await advanceStory(db, storyId);
  for (const id of ids) await advance(db, id);
}

/** Permanently delete stories that have been in the trash for TRASH_DAYS days. */
export async function purgeDeletedStories(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 24 * 3600 * 1000);
  const due = await db
    .select({ id: stories.id })
    .from(stories)
    .where(and(eq(stories.status, "deleted"), lt(stories.deletedAt, cutoff)));
  for (const s of due) await deleteStory(db, s.id);
  return due.map((s) => s.id);
}

/** "Delete forever" from the trash, before the purge would. */
export async function deleteTrashedStory(db: Db, storyId: string, typedTitle: string): Promise<{ filesDeleted: number }> {
  const story = await requireStory(db, storyId);
  if (story.status !== "deleted") throw new Error("Move the story to the trash first.");
  if (typedTitle.trim() !== story.title.trim()) throw new Error("The story name you typed doesn't match.");
  return deleteStory(db, storyId);
}

// ── Episode versions ──────────────────────────────────────────────────────

async function requireVersion(db: Db, projectId: string): Promise<ProjectRow & { episodeId: string; storyId: string }> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new Error("Version not found.");
  if (!p.episodeId || !p.storyId) throw new Error("This project is not filed in a story folder.");
  return p as ProjectRow & { episodeId: string; storyId: string };
}

/** Make a version the active one: the current active version is stopped (kept), this one resumes. */
export async function activateVersion(db: Db, projectId: string): Promise<void> {
  const p = await requireVersion(db, projectId);
  const story = await requireStory(db, p.storyId);
  if (story.status === "deleted") throw new Error("Restore the story from the trash first.");
  let previous: string | null = null;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [ep] = await tx.select().from(episodes).where(eq(episodes.id, p.episodeId)).for("update");
    previous = ep.activeVersionId;
    if (previous !== projectId) {
      await tx.update(episodes).set({ activeVersionId: projectId, updatedAt: new Date() }).where(eq(episodes.id, ep.id));
      if (previous) await archiveProject(tx, previous);
    }
    await tx.update(projects).set({ archived: false }).where(eq(projects.id, projectId));
  });
  if (previous === projectId) {
    // Already active but stopped (e.g. migrated with every version archived): resume it.
    if (p.archived) {
      await logEvent(db, projectId, null, "info", `Version ${p.version} resumed.`);
      await advance(db, projectId);
    }
    return;
  }
  await logEvent(db, projectId, null, "info", `Version ${p.version} is now the active version of Episode ${p.episodeNumber}.`);
  await refreshStoryStateCache(db, p.storyId);
  await revalidateLaterEpisodes(db, p.storyId, p.episodeNumber);
  await advance(db, projectId);
}

/**
 * Delete one version with its files. Deleting the active version activates the newest remaining one; deleting
 * the last version removes the episode. Later episodes are re-checked either way.
 */
export async function deleteVersion(db: Db, projectId: string): Promise<{ filesDeleted: number; episodeRemoved: boolean }> {
  const p = await requireVersion(db, projectId);
  const [ep] = await db.select().from(episodes).where(eq(episodes.id, p.episodeId));
  const others = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.episodeId, p.episodeId), ne(projects.id, projectId)))
    .orderBy(desc(projects.version));
  if (ep?.activeVersionId === projectId && others.length) await activateVersion(db, others[0].id);
  const { filesDeleted } = await deleteProject(db, projectId);
  const episodeRemoved = others.length === 0;
  if (episodeRemoved && ep) await db.delete(episodes).where(eq(episodes.id, ep.id));
  await logEvent(
    db,
    { storyId: p.storyId },
    null,
    "info",
    episodeRemoved ? `Episode ${p.episodeNumber} deleted (its only version).` : `Episode ${p.episodeNumber} version ${p.version} deleted.`,
  );
  if (episodeRemoved) {
    await refreshStoryStateCache(db, p.storyId);
    await revalidateLaterEpisodes(db, p.storyId, p.episodeNumber);
  }
  return { filesDeleted, episodeRemoved };
}

/** Store the same JSON again as a new version (active, not started), e.g. to run the whole pipeline fresh. */
export async function duplicateVersion(db: Db, projectId: string): Promise<string> {
  const p = await requireVersion(db, projectId);
  const out = await ingestDocument(db, p.rawJson, {
    scopeStoryId: p.storyId,
    adjust: (e) => {
      e.automation = { ...e.automation, auto_start_on_submit: false };
    },
  });
  if (out.error || !out.projectId) throw new Error(out.error ?? "Nothing was stored.");
  await logEvent(db, out.projectId, null, "info", `Duplicated from version ${p.version}.`);
  return out.projectId;
}

// ── Status roll-up ────────────────────────────────────────────────────────

/** Project ids with a queued or running bot task. */
export async function botBusyProjects(db: Db, projectIds: string[]): Promise<Set<string>> {
  if (!projectIds.length) return new Set();
  const rows = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(and(inArray(tasks.projectId, projectIds), eq(tasks.kind, "bot"), inArray(tasks.status, ["queued", "leased"])));
  return new Set(rows.map((r) => r.projectId!));
}

export interface EpisodeListItem {
  episodeId: string;
  number: number;
  title: string;
  migrated: boolean;
  versions: number;
  active: ProjectRow | null;
  bucket: StatusBucket | null;
}

/** A folder's episodes in number order, with their active versions. */
export async function listEpisodes(db: Db, storyId: string): Promise<EpisodeListItem[]> {
  const eps = await db.select().from(episodes).where(eq(episodes.storyId, storyId)).orderBy(asc(episodes.number));
  const versions = await db.select().from(projects).where(eq(projects.storyId, storyId));
  const busy = await botBusyProjects(db, eps.map((e) => e.activeVersionId).filter((x): x is string => !!x));
  return eps.map((e) => {
    const mine = versions.filter((v) => v.episodeId === e.id);
    const active = mine.find((v) => v.id === e.activeVersionId) ?? null;
    return {
      episodeId: e.id,
      number: e.number,
      title: e.title,
      migrated: e.migrated,
      versions: mine.length,
      active,
      bucket: active ? statusBucket(active.state, busy.has(active.id)) : null,
    };
  });
}

/** Missing numbers between 1 and the highest episode. */
export function episodeGaps(numbers: number[]): number[] {
  const have = new Set(numbers);
  const max = Math.max(0, ...numbers);
  const gaps: number[] = [];
  for (let n = 1; n < max; n++) if (!have.has(n)) gaps.push(n);
  return gaps;
}

// ── {{series_nav}} ────────────────────────────────────────────────────────

/** Neighbouring episodes' published links and "Episode N of M" for one version. */
export async function seriesNavFor(db: Db, projectId: string): Promise<SeriesNav | null> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p?.storyId) return null;
  const story = await getStory(db, p.storyId);
  const rows = await db
    .select({ number: episodes.number, title: episodes.title, url: projects.youtubeUrl })
    .from(episodes)
    .leftJoin(projects, eq(projects.id, episodes.activeVersionId))
    .where(eq(episodes.storyId, p.storyId));
  const at = (n: number) => rows.find((r) => r.number === n) ?? null;
  const prev = at(p.episodeNumber - 1);
  const next = at(p.episodeNumber + 1);
  return {
    episode_number: p.episodeNumber,
    total_planned: (story?.bible as StoryBible | null)?.total_episodes_planned ?? null,
    previous: prev ? { number: prev.number, title: prev.title, url: prev.url } : null,
    next: next ? { number: next.number, title: next.title, url: next.url } : null,
  };
}

/**
 * Re-render `{{series_nav}}` in the stored description of the versions next to a newly published one (only
 * descriptions not yet uploaded change; a published video's YouTube description is not edited).
 */
export async function refreshNeighbourNav(db: Db, projectId: string): Promise<void> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p?.storyId) return;
  const neighbours = await db
    .select({ id: episodes.activeVersionId })
    .from(episodes)
    .where(and(eq(episodes.storyId, p.storyId), inArray(episodes.number, [p.episodeNumber - 1, p.episodeNumber + 1])));
  for (const n of neighbours) {
    if (!n.id) continue;
    const [row] = await db.select().from(projects).where(eq(projects.id, n.id));
    const out = row?.outputs as { description_template?: string } | undefined;
    if (!row || row.publishedAt || !out?.description_template) continue;
    const rendered = applySeriesNav(out.description_template, await seriesNavFor(db, row.id));
    await db
      .update(projects)
      .set({ outputs: { ...(row.outputs as object), description: rendered.description, description_bytes: rendered.bytes, description_error: rendered.error } })
      .where(eq(projects.id, row.id));
  }
}

// ── Paste preview (auto-routing) ──────────────────────────────────────────

export type PlanAction =
  | "create_story"
  | "fill_story"
  | "update_bible"
  | "bible_unchanged"
  | "add_episode"
  | "new_version"
  | "create_story_with_episode";

export interface IngestPlan {
  ok: boolean;
  docType: DocType | null;
  action: PlanAction | null;
  storyId: string | null;
  storyTitle: string | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  /** The version number the episode would get, and the one it would replace. */
  nextVersion: number | null;
  replaces: { projectId: string; version: number; state: string; published: boolean } | null;
  /** One sentence: "This will add Episode 3 'Title' to The Rising." */
  summary: string;
  /** What changes against the stored version or bible. */
  diff: string[];
  warnings: string[];
  errors: { message: string; href?: string; linkLabel?: string }[];
}

function segmentDiff(before: EpisodeDoc | null, after: EpisodeDoc | null): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  const title = (d: EpisodeDoc) => d.episode_title ?? d.series.episode_title_short;
  if (title(before) !== title(after)) out.push(`Title: "${title(before)}" → "${title(after)}"`);
  if (before.youtube.title !== after.youtube.title) out.push(`YouTube title: "${before.youtube.title}" → "${after.youtube.title}"`);
  const a = new Map(before.segments.map((s) => [s.id, JSON.stringify(s)]));
  const b = new Map(after.segments.map((s) => [s.id, JSON.stringify(s)]));
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id));
  out.push(`Segments: ${before.segments.length} → ${after.segments.length}`);
  if (added.length) out.push(`Added: ${added.slice(0, 8).join(", ")}${added.length > 8 ? ", …" : ""}`);
  if (removed.length) out.push(`Removed: ${removed.slice(0, 8).join(", ")}${removed.length > 8 ? ", …" : ""}`);
  if (changed.length) out.push(`Changed: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? ", …" : ""}`);
  if (!added.length && !removed.length && !changed.length) out.push("No segment changes.");
  for (const key of ["thumbnail", "youtube", "automation", "overrides", "bible_additions", "character_status_changes"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out.push(`${key} changed`);
  }
  return out;
}

/** The stored version's episode document, parsed the same way as a new paste so the diff compares like with like. */
function storedDoc(p: ProjectRow): EpisodeDoc | null {
  const { raw } = parseJsonText(p.rawJson);
  const r = raw as { doc_type?: string; episode?: unknown } | undefined;
  const doc = r?.doc_type === "bundle" ? r.episode : raw;
  const parsed = EpisodeDocSchema.safeParse(normalizeEpisodeHeader(doc).raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What pasting this document would do, without storing anything: the confirmation shown before a story is
 * created, a bible updated, or an episode/version added.
 */
export async function planIngest(db: Db, text: string, scopeStoryId?: string | null): Promise<IngestPlan> {
  const plan: IngestPlan = {
    ok: false,
    docType: null,
    action: null,
    storyId: null,
    storyTitle: null,
    episodeNumber: null,
    episodeTitle: null,
    nextVersion: null,
    replaces: null,
    summary: "",
    diff: [],
    warnings: [],
    errors: [],
  };
  const { raw, errors } = parseJsonText(text);
  if (errors.length) {
    plan.errors.push({ message: errors[0].message });
    return plan;
  }
  const { doc_type } = detectDocType(raw);
  const header = readHeader(raw);
  plan.docType = doc_type;
  plan.storyId = header.story_id;
  plan.episodeNumber = header.episode_number;
  plan.episodeTitle = header.episode_title;
  const validation = await validateWithStore(db, text, undefined, scopeStoryId);
  plan.warnings = validation.warnings.map((w) => w.message);
  if (!validation.ok) {
    const unknown = doc_type === "episode" && validation.needs_story && !(await getStory(db, validation.needs_story));
    plan.errors = validation.errors.slice(0, 8).map((e) => ({ message: `${e.path_text}: ${e.message}` }));
    if (unknown) {
      plan.errors.unshift({
        message: `Story "${validation.needs_story}" does not exist.`,
        href: `/stories?new=${encodeURIComponent(validation.needs_story!)}`,
        linkLabel: "Create the story",
      });
    }
    return plan;
  }
  const storyId = validation.story?.story_id ?? validation.episode?.story.story_id ?? header.story_id;
  const story = storyId ? await getStory(db, storyId) : null;
  plan.storyId = storyId;
  plan.storyTitle = story?.title ?? validation.story?.story_title ?? header.story_title;

  if (validation.story) {
    const bible = validation.story;
    if (story?.bible) {
      if (bible.story_title.trim() !== story.title.trim()) {
        plan.warnings.unshift(`This bible's story_title '${bible.story_title}' differs from the stored title '${story.title}'. Using the stored title.`);
      }
      if (sameBible(story.bible as StoryBible, bible)) {
        plan.action = doc_type === "bundle" ? null : "bible_unchanged";
        plan.diff.push("The story bible is identical to the stored one.");
      } else {
        const versions = await db.select({ id: projects.id }).from(projects).where(eq(projects.storyId, story.id)).limit(1);
        const problems = versions.length ? supersetProblems(story.bible as StoryBible, bible) : [];
        if (problems.length) {
          plan.errors.push({ message: `This story has episodes, so the bible may only add things: ${problems.slice(0, 6).join("; ")}.` });
          return plan;
        }
        const before = new Set(bibleIds(story.bible as StoryBible));
        const added = bibleIds(bible).filter((id) => !before.has(id));
        plan.action = doc_type === "bundle" ? null : "update_bible";
        plan.diff.push(added.length ? `Adds ${added.length}: ${added.slice(0, 10).join(", ")}${added.length > 10 ? ", …" : ""}` : "Changes descriptions only (no new ids).");
      }
    } else {
      plan.action = story ? "fill_story" : "create_story";
    }
  }

  const ep = validation.episode;
  if (ep) {
    const number = ep.series.episode_number;
    plan.episodeNumber = number;
    plan.episodeTitle = ep.episode_title ?? ep.series.episode_title_short;
    const [row] = story ? await db.select().from(episodes).where(and(eq(episodes.storyId, story.id), eq(episodes.number, number))) : [];
    plan.nextVersion = (row?.versionCounter ?? 0) + 1;
    const active = row?.activeVersionId ? (await db.select().from(projects).where(eq(projects.id, row.activeVersionId)))[0] : undefined;
    if (active) {
      plan.replaces = { projectId: active.id, version: active.version, state: active.state, published: !!active.publishedAt };
      plan.diff.push(...segmentDiff(storedDoc(active), validation.episode_doc));
      if (active.publishedAt) plan.warnings.unshift(`Version ${active.version} is already published; the YouTube video is not changed.`);
    }
    plan.action = !story ? "create_story_with_episode" : active ? "new_version" : "add_episode";
  }

  const t = plan.storyTitle ?? plan.storyId ?? "the story";
  const epName = `Episode ${plan.episodeNumber} '${plan.episodeTitle}'`;
  plan.summary = {
    create_story: `This will create the story "${t}" (${plan.storyId}).`,
    fill_story: `This will add the story bible to "${t}".`,
    update_bible: `This will update the story bible of "${t}" (additions only).`,
    bible_unchanged: `"${t}" already has this exact bible. Nothing will change.`,
    add_episode: `This will add ${epName} to ${t}.`,
    new_version: `This will add ${epName} to ${t} as version ${plan.nextVersion}, replacing version ${plan.replaces?.version} (kept, but stopped).`,
    create_story_with_episode: `This will create the story "${t}" and add ${epName} to it.`,
  }[plan.action ?? "bible_unchanged"];
  if (doc_type === "bundle" && story?.bible && plan.diff[0]?.startsWith("Adds")) plan.summary += " The story bible gains additions.";
  plan.ok = plan.errors.length === 0;
  return plan;
}

// ── Folder list ───────────────────────────────────────────────────────────

export interface StorySummary {
  story: StoryRow;
  episodes: number;
  planned: number | null;
  buckets: Partial<Record<StatusBucket, number>>;
  lastActivity: Date;
  /** Latest ready main thumbnail among the active versions. */
  cover: AssetRow | null;
}

/** Folders for /stories: `view` "active" (with archived when `withArchived`) or "trash". */
export async function storySummaries(db: Db, view: "active" | "trash", withArchived = false): Promise<StorySummary[]> {
  const where = view === "trash" ? eq(stories.status, "deleted") : withArchived ? ne(stories.status, "deleted") : eq(stories.status, "active");
  const rows = await db.select().from(stories).where(where).orderBy(desc(stories.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const eps = await db
    .select({ storyId: episodes.storyId, projectId: projects.id, state: projects.state, updatedAt: projects.updatedAt })
    .from(episodes)
    .leftJoin(projects, eq(projects.id, episodes.activeVersionId))
    .where(inArray(episodes.storyId, ids));
  const activeIds = eps.map((e) => e.projectId).filter((x): x is string => !!x);
  const busy = await botBusyProjects(db, activeIds);
  const thumbs = activeIds.length
    ? await db
        .select()
        .from(assets)
        .where(and(inArray(assets.projectId, activeIds), eq(assets.assetKey, "thumbnail/0"), eq(assets.status, "ready")))
        .orderBy(desc(assets.createdAt))
    : [];
  return rows
    .sort((a, b) => Number(a.id === UNSORTED_STORY_ID) - Number(b.id === UNSORTED_STORY_ID))
    .map((story) => {
      const mine = eps.filter((e) => e.storyId === story.id);
      const buckets: Partial<Record<StatusBucket, number>> = {};
      let last = story.updatedAt;
      for (const e of mine) {
        if (!e.state || !e.projectId) continue;
        const b = statusBucket(e.state, busy.has(e.projectId));
        buckets[b] = (buckets[b] ?? 0) + 1;
        if (e.updatedAt && e.updatedAt > last) last = e.updatedAt;
      }
      const mineIds = new Set(mine.map((e) => e.projectId));
      return {
        story,
        episodes: mine.length,
        planned: (story.bible as StoryBible | null)?.total_episodes_planned ?? null,
        buckets,
        lastActivity: last,
        cover: thumbs.find((t) => mineIds.has(t.projectId)) ?? null,
      };
    });
}

// ── Sidebar tree ──────────────────────────────────────────────────────────

export interface TreeStory {
  id: string;
  title: string;
  status: string;
  episodes: { number: number; title: string; bucket: StatusBucket | null }[];
}

export async function folderTree(db: Db): Promise<TreeStory[]> {
  const rows = await db.select({ id: stories.id, title: stories.title, status: stories.status }).from(stories).where(ne(stories.status, "deleted")).orderBy(asc(stories.title));
  const eps = await db
    .select({ storyId: episodes.storyId, number: episodes.number, title: episodes.title, state: projects.state, projectId: projects.id })
    .from(episodes)
    .leftJoin(projects, eq(projects.id, episodes.activeVersionId))
    .orderBy(asc(episodes.number));
  const busy = await botBusyProjects(db, eps.map((e) => e.projectId).filter((x): x is string => !!x));
  return rows
    .sort((a, b) => Number(a.id === UNSORTED_STORY_ID) - Number(b.id === UNSORTED_STORY_ID))
    .map((s) => ({
      ...s,
      episodes: eps
        .filter((e) => e.storyId === s.id)
        .map((e) => ({ number: e.number, title: e.title, bucket: e.state ? statusBucket(e.state, busy.has(e.projectId!)) : null })),
    }));
}

export type { ValidationIssue };
