import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory://";
process.env.LOCAL_STORAGE_DIR = path.join(".data", "test-storage-v23");

import { createAsset } from "@/lib/assets";
import { getDb, type Db } from "@/lib/db";
import { assets, episodes, projects, storyStateSnapshots, tasks } from "@/lib/db/schema";
import { normalizeEpisodeHeader, readHeader } from "@/lib/episode/header";
import { episodeHref, outputBasename, slugify } from "@/lib/episode/naming";
import { statusBucket } from "@/lib/episode/status";
import { validateText } from "@/lib/episode/validate";
import { applySeriesNav, seriesNavText } from "@/lib/pipeline/description";
import {
  activateVersion,
  createEmptyStory,
  deleteVersion,
  duplicateVersion,
  episodeGaps,
  folderTree,
  listEpisodes,
  planIngest,
  purgeDeletedStories,
  renameStory,
  restoreStory,
  seriesNavFor,
  softDeleteStory,
  storySummaries,
} from "@/lib/pipeline/folders";
import { ingestDocument } from "@/lib/pipeline/ingest";
import { hydrateTask } from "@/lib/pipeline/payloads";
import type { Revalidation } from "@/lib/pipeline/revalidate";
import { relocateAssets } from "@/lib/pipeline/relocate";
import { activeSnapshots } from "@/lib/pipeline/snapshots";
import { getStory } from "@/lib/pipeline/story";
import { episodeObjectPrefix, getStorage, projectObjectKey, storyObjectKey } from "@/lib/storage";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let db: Db;
beforeAll(async () => {
  db = await getDb();
});

const bibleText = (mutate?: (b: Raw) => void) => {
  const b = json("story_bible_example.json");
  b.automation.approval_gates.location_masters = false;
  mutate?.(b);
  return JSON.stringify(b);
};

async function ingest(doc: Raw | string, scopeStoryId?: string) {
  const out = await ingestDocument(db, typeof doc === "string" ? doc : JSON.stringify(doc), { scopeStoryId });
  return out;
}

async function ok(doc: Raw | string, scopeStoryId?: string) {
  const out = await ingest(doc, scopeStoryId);
  expect(out.validation.errors.map((e) => e.message)).toEqual([]);
  expect(out.error).toBeNull();
  return out;
}

const version = async (id: string) => (await db.select().from(projects).where(eq(projects.id, id)))[0];
const episodeRow = async (storyId: string, n: number) =>
  (await db.select().from(episodes).where(and(eq(episodes.storyId, storyId), eq(episodes.number, n))))[0];

/** Episode 1 without the barricade: the rooftop stays "clear". */
const ep1Unbarricaded = () => {
  const ep = json("episode_1.json");
  ep.segments[2].scene.state_id = "clear";
  delete ep.segments[2].scene.state_changes;
  ep.thumbnail.scene.state_id = "clear";
  return ep;
};

describe("episode header (2.3)", () => {
  it("requires episode_number and episode_title, fills series and youtube.title from them", () => {
    const ep = json("episode_1.json");
    const n = normalizeEpisodeHeader(ep).raw as Raw;
    expect(n.series.episode_number).toBe(1);
    expect(n.series.episode_title_short).toBe("Day One");
    expect(n.youtube.title).toBe("Rooftop Test Story Ep. 1: Day One");
    expect((normalizeEpisodeHeader(ep, [], { storyTitle: "Renamed" }).raw as Raw).youtube.title).toBe("Renamed Ep. 1: Day One");

    delete ep.episode_number;
    delete ep.episode_title;
    const issues = normalizeEpisodeHeader(ep).issues.map((i) => i.message).join("\n");
    expect(issues).toMatch(/"episode_number" is required/);
    expect(issues).toMatch(/"episode_title" is required/);
  });

  it("rejects a top-level episode_number that disagrees with series", () => {
    const ep = json("episode_1.json");
    ep.series.episode_number = 2;
    const r = validateText(JSON.stringify(ep));
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/episode_number 1 disagrees with series.episode_number 2/);
  });

  it("older 2.2 documents keep working with the number in series", () => {
    const ep = json("episode_1.json");
    ep.schema_version = "2.2";
    ep.series.episode_number = 1;
    ep.series.episode_title_short = "Day One";
    delete ep.episode_number;
    delete ep.episode_title;
    expect(readHeader(ep)).toMatchObject({ story_id: "rooftop-test", episode_number: 1, episode_title: "Day One" });
  });
});

describe("story folders", () => {
  it("creates a story by pasting its bible, and an identical re-paste changes nothing", async () => {
    const plan = await planIngest(db, bibleText());
    expect(plan).toMatchObject({ ok: true, action: "create_story", storyId: "rooftop-test" });
    expect(plan.summary).toBe('This will create the story "Rooftop Test Story" (rooftop-test).');
    const first = await ok(bibleText());
    expect(first.bible).toBe("created");
    const story = await getStory(db, "rooftop-test");
    expect(story).toMatchObject({ title: "Rooftop Test Story", status: "active", bibleVersion: 1 });
    expect((await ok(bibleText())).bible).toBe("unchanged");
    expect((await planIngest(db, bibleText())).action).toBe("bible_unchanged");
    expect((await getStory(db, "rooftop-test"))!.bibleVersion).toBe(1);
  });

  it("creates an empty story with New story, refuses episodes until its bible arrives", async () => {
    const id = await createEmptyStory(db, { title: "Harbour Test Story", slug: "harbour-test" });
    expect(id).toBe("harbour-test");
    await expect(createEmptyStory(db, { title: "Again", slug: "harbour-test" })).rejects.toThrow(/already/);
    const ep = json("episode_second_story_1.json");
    const early = await ingest(ep);
    expect(early.error).toMatch(/has no story bible yet\. Add the story bible first\./);
    const filled = await ok(fixture("story_bible_second.json"));
    expect(filled.bible).toBe("filled");
    await ok(ep);
  });

  it("previews an episode: 'This will add Episode 1 ...' and a link for unknown stories", async () => {
    const plan = await planIngest(db, fixture("episode_1.json"));
    expect(plan.action).toBe("add_episode");
    expect(plan.summary).toBe("This will add Episode 1 'Day One' to Rooftop Test Story.");
    const ghost = json("episode_1.json");
    ghost.story_id = "ghost-story";
    const missing = await planIngest(db, JSON.stringify(ghost));
    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toMatchObject({ href: "/stories?new=ghost-story", linkLabel: "Create the story" });
  });

  it("refuses a file for another story when pasted inside a folder", async () => {
    const out = await ingest(json("episode_1.json"), "harbour-test");
    expect(out.error).toMatch(/belongs to story "rooftop-test", not "harbour-test"/);
  });

  it("a bundle creates the story and the episode", async () => {
    const bible = JSON.parse(bibleText((b) => {
      b.story_id = "bundle-test";
      b.story_title = "Bundle Test";
    }));
    const episode = { ...json("episode_1.json"), story_id: "bundle-test", story_title: "Bundle Test" };
    const bundle = { schema_version: "2.3", doc_type: "bundle", story_bible: bible, episode };
    expect((await planIngest(db, JSON.stringify(bundle))).action).toBe("create_story_with_episode");
    const out = await ok(bundle);
    expect(out).toMatchObject({ storyId: "bundle-test", version: 1, bible: "created" });
    const p = await version(out.projectId!);
    expect(p.episode).toMatchObject({ youtube: { playlist: "Bundle Test", title: "Bundle Test Ep. 1: Day One" } });
  });

  it("keeps stories independent", async () => {
    const tree = await folderTree(db);
    const harbour = tree.find((s) => s.id === "harbour-test")!;
    expect(harbour.episodes.map((e) => e.number)).toEqual([1]);
    expect(tree.find((s) => s.id === "rooftop-test")!.episodes).toEqual([]);
  });
});

describe("versions, snapshots and revalidation", () => {
  let v1: string;
  let ep2: string;

  it("stores episode 1 and its story state snapshot", async () => {
    const out = await ok(json("episode_1.json"));
    v1 = out.projectId!;
    expect(out.version).toBe(1);
    const snaps = await activeSnapshots(db, "rooftop-test");
    expect(snaps.map((s) => [s.episodeNumber, s.state.locations.rooftop])).toEqual([[1, "barricaded"]]);
  });

  it("validates episode 2 against the state after episode 1, even while episode 1 is still running", async () => {
    expect((await version(v1)).state).not.toBe("PUBLISHED");
    const out = await ok(json("episode_2.json"));
    ep2 = out.projectId!;
    expect(out.validation.warnings.map((w) => w.message).join("\n")).not.toMatch(/missing/);
  });

  it("warns when the story_title differs from the stored title", async () => {
    const ep = json("episode_2.json");
    ep.story_title = "Rooftop";
    const r = await planIngest(db, JSON.stringify(ep));
    expect(r.warnings).toContain("This episode's story_title 'Rooftop' differs from the stored title 'Rooftop Test Story'. Using the stored title.");
  });

  it("re-pasting episode 1 makes version 2 active, keeps version 1 stopped, and re-checks episode 2", async () => {
    const plan = await planIngest(db, JSON.stringify(ep1Unbarricaded()));
    expect(plan).toMatchObject({ action: "new_version", nextVersion: 2, replaces: { version: 1 } });
    expect(plan.diff.join("\n")).toMatch(/Changed: seg_003/);

    const out = await ok(ep1Unbarricaded());
    expect(out).toMatchObject({ version: 2, replaced: v1 });
    const e1 = await episodeRow("rooftop-test", 1);
    expect(e1.activeVersionId).toBe(out.projectId);
    expect(e1.versionCounter).toBe(2);
    expect((await version(v1)).archived).toBe(true);
    const openTasks = await db.select().from(tasks).where(and(eq(tasks.projectId, v1), eq(tasks.status, "queued")));
    expect(openTasks).toEqual([]);

    const later = await version(ep2);
    expect(later.needsRevalidation).toBe(true);
    const rv = later.revalidation as Revalidation;
    expect(rv.ok).toBe(false);
    expect(rv.errors.map((e) => e.message)).toContain(
      "seg_002: Episode 2 uses location 'rooftop' in state 'barricaded', but the story state after Episode 1 is 'clear' and no state change is declared.",
    );
  });

  it("setting version 1 active again clears the flag", async () => {
    await activateVersion(db, v1);
    expect((await episodeRow("rooftop-test", 1)).activeVersionId).toBe(v1);
    expect((await version(v1)).archived).toBe(false);
    const later = await version(ep2);
    expect(later.needsRevalidation).toBe(false);
    expect((later.revalidation as Revalidation).ok).toBe(true);
  });

  it("duplicates a version as a new, unstarted active version", async () => {
    const dup = await duplicateVersion(db, v1);
    const row = await version(dup);
    expect(row).toMatchObject({ version: 3, state: "DRAFT", archived: false });
    expect((await episodeRow("rooftop-test", 1)).activeVersionId).toBe(dup);
    expect((await listEpisodes(db, "rooftop-test")).find((e) => e.number === 1)!.versions).toBe(3);
  });

  it("deleting the active version activates the newest remaining one; numbers are never reused", async () => {
    const e1 = await episodeRow("rooftop-test", 1);
    await deleteVersion(db, e1.activeVersionId!);
    const after = await episodeRow("rooftop-test", 1);
    const active = await version(after.activeVersionId!);
    expect(active.version).toBe(2);
    const again = await ok(json("episode_1.json"));
    expect(again.version).toBe(4);
    expect((await version(ep2)).needsRevalidation).toBe(false);
    const snaps = await db.select().from(storyStateSnapshots).where(eq(storyStateSnapshots.storyId, "rooftop-test"));
    expect(snaps.every((s) => s.projectId !== e1.activeVersionId)).toBe(true);
  });

  it("warns about gaps and computes continuity from the last episode before the gap", async () => {
    const ep4 = json("episode_2.json");
    ep4.episode_number = 4;
    ep4.episode_title = "Day Four";
    const out = await ok(ep4);
    expect(out.validation.warnings.map((w) => w.message)).toContain(
      "Episode 4 was added while Episode 3 is missing. State continuity is computed from Episode 2.",
    );
    expect(episodeGaps((await listEpisodes(db, "rooftop-test")).map((e) => e.number))).toEqual([3]);
  });
});

describe("task metadata and paths", () => {
  it("bot and worker payloads name the story and episode, and files use the folder layout", async () => {
    const e2 = await episodeRow("rooftop-test", 2);
    const [task] = await db.select().from(tasks).where(eq(tasks.projectId, e2.activeVersionId!));
    expect(task).toBeDefined();
    const hydrated = await hydrateTask(db, task, "http://localhost:3000");
    expect(hydrated).toMatchObject({
      story_id: "rooftop-test",
      story_title: "Rooftop Test Story",
      episode_number: 2,
      episode_title: "The Knock",
      version: 1,
      output_basename: "rooftop-test-ep02-v1-the-knock",
    });

    const asset = await createAsset(db, { projectId: e2.activeVersionId!, taskId: null, assetKey: "image/seg_002", contentType: "image/png", status: "pending", meta: {} });
    expect(asset.storageKey).toMatch(/stories\/rooftop-test\/ep02\/v1\/image\/seg_002/);
    expect(episodeObjectPrefix("rooftop-test", 2, 1)).toMatch(/stories\/rooftop-test\/ep02\/v1\/$/);
    expect(storyObjectKey("rooftop-test", "master/loc/rooftop/clear/a.png")).toMatch(/stories\/rooftop-test\/masters\/loc\/rooftop\/clear\/a\.png$/);
    expect(() => episodeObjectPrefix("../x", 1, 1)).toThrow();
  });

  it("moves pre-2.3 files into the story folder layout and keeps them readable", async () => {
    const e2 = await episodeRow("rooftop-test", 2);
    const old = projectObjectKey(e2.activeVersionId!, "voice/seg_002/ast_old.flac");
    await getStorage().put(old, new Uint8Array([1, 2, 3]), "audio/flac");
    const [row] = await db
      .insert(assets)
      .values({ id: "ast_old", projectId: e2.activeVersionId!, taskId: null, assetKey: "voice/seg_002", kind: "voice", storageKey: old, contentType: "audio/flac", status: "ready" })
      .returning();
    const dry = await relocateAssets(db);
    expect(dry.planned.find((p) => p.assetId === row.id)?.to).toMatch(/stories\/rooftop-test\/ep02\/v1\/voice\/seg_002\/ast_old\.flac$/);
    expect(dry.moved).toBe(0);
    const done = await relocateAssets(db, { apply: true, deleteOld: true });
    expect(done.failed).toEqual([]);
    const [moved] = await db.select().from(assets).where(eq(assets.id, row.id));
    expect(moved.storageKey).toMatch(/stories\/rooftop-test\/ep02\/v1\//);
    expect([...(await getStorage().get(moved.storageKey))]).toEqual([1, 2, 3]);
    expect(await getStorage().head(old)).toBeNull();
  });

  it("names, links and status buckets", () => {
    expect(slugify("The Rising: Day One!")).toBe("the-rising-day-one");
    expect(outputBasename("the-rising", 1, 2, "Day One")).toBe("the-rising-ep01-v2-day-one");
    expect(episodeHref("the-rising", 3, 2)).toBe("/stories/the-rising/episodes/3?v=2");
    expect(statusBucket("RENDER", false)).toBe("in_progress");
    expect(statusBucket("VALIDATED", true)).toBe("awaiting_bot");
    expect(statusBucket("REVIEW", false)).toBe("ready");
  });

  it("{{series_nav}} links neighbours once their URLs are known", async () => {
    expect(
      seriesNavText({ episode_number: 2, total_planned: 3, previous: { number: 1, title: "Day One", url: "https://youtu.be/a" }, next: { number: 3, title: "Day Three", url: null } }),
    ).toBe("Episode 2 of 3\nPrevious: Ep 1 - Day One: https://youtu.be/a");
    expect(applySeriesNav("Intro\n\n{{series_nav}}\n\nEnd", null).description).toBe("Intro\n\nEnd");

    const e1 = await episodeRow("rooftop-test", 1);
    await db.update(projects).set({ youtubeUrl: "https://youtu.be/ep1" }).where(eq(projects.id, e1.activeVersionId!));
    const e2 = await episodeRow("rooftop-test", 2);
    const nav = await seriesNavFor(db, e2.activeVersionId!);
    expect(nav).toMatchObject({ episode_number: 2, total_planned: 3, previous: { number: 1, url: "https://youtu.be/ep1" } });
  });
});

describe("rename, trash and restore", () => {
  it("renames the title only", async () => {
    await renameStory(db, "harbour-test", "The Harbour");
    const s = await getStory(db, "harbour-test");
    expect(s).toMatchObject({ id: "harbour-test", title: "The Harbour" });
  });

  it("soft delete needs the typed name, stops the story's tasks, and restore brings it back", async () => {
    await expect(softDeleteStory(db, "rooftop-test", "wrong")).rejects.toThrow(/doesn't match/);
    const before = await db.select().from(tasks).where(eq(tasks.status, "queued"));
    expect(before.length).toBeGreaterThan(0);
    await softDeleteStory(db, "rooftop-test", "Rooftop Test Story");
    const s = await getStory(db, "rooftop-test");
    expect(s).toMatchObject({ status: "deleted" });
    const versions = await db.select().from(projects).where(eq(projects.storyId, "rooftop-test"));
    expect(versions.every((v) => v.archived)).toBe(true);
    const ids = new Set(versions.map((v) => v.id));
    const open = (await db.select().from(tasks).where(eq(tasks.status, "queued"))).filter((t) => (t.projectId && ids.has(t.projectId)) || t.storyId === "rooftop-test");
    expect(open).toEqual([]);
    expect((await folderTree(db)).some((t) => t.id === "rooftop-test")).toBe(false);
    expect((await storySummaries(db, "trash")).map((r) => r.story.id)).toContain("rooftop-test");
    expect((await ingest(json("episode_2.json"))).error).toMatch(/is in the trash/);

    await restoreStory(db, "rooftop-test");
    expect((await getStory(db, "rooftop-test"))!.status).toBe("active");
    const actives = await db.select({ id: episodes.activeVersionId }).from(episodes).where(eq(episodes.storyId, "rooftop-test"));
    for (const a of actives) expect((await version(a.id!)).archived).toBe(false);
  });

  it("purges stories that have been in the trash for 30 days", async () => {
    await softDeleteStory(db, "bundle-test", "Bundle Test");
    expect(await purgeDeletedStories(db, new Date(Date.now() + 29 * 86_400_000))).toEqual([]);
    expect(await purgeDeletedStories(db, new Date(Date.now() + 31 * 86_400_000))).toEqual(["bundle-test"]);
    expect(await getStory(db, "bundle-test")).toBeNull();
    expect(await db.select().from(projects).where(eq(projects.storyId, "bundle-test"))).toEqual([]);
  });
});

describe("migration 0005 (story folders)", () => {
  it("files old projects into episodes and versions, and unsorted projects into 'Unsorted'", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { readdirSync } = await import("node:fs");
    const pg = new PGlite("memory://");
    const dir = path.join(__dirname, "..", "drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const run = async (f: string) => pg.exec(readFileSync(path.join(dir, f), "utf8"));
    for (const f of files.filter((f) => f < "0005")) await run(f);

    const state = JSON.stringify({ current: {}, by_episode: {}, committed_through_episode: 0 });
    await pg.exec(`
      INSERT INTO stories (id, title, state, bible, raw_json, story_state, archived) VALUES
        ('old-story', 'Old Story', 'STORY_VALIDATED', '{}', '{}', '${state}', false);
      INSERT INTO projects (id, story_id, series_id, episode_number, title, state, episode, raw_json, estimate, outputs, archived, created_at) VALUES
        ('prj_a', 'old-story', 'old-story', 1, 'First take', 'PUBLISHED', '{}', '{}', '{}', '{"story_state_end": {"locations": {"x": "y"}}}', false, now() - interval '3 days'),
        ('prj_b', 'old-story', 'old-story', 1, 'Second take', 'RENDER', '{}', '{}', '{}', '{}', false, now() - interval '2 days'),
        ('prj_c', 'old-story', 'old-story', 2, 'Ep two', 'DRAFT', '{}', '{}', '{}', '{}', false, now() - interval '1 day'),
        ('prj_d', NULL, 'legacy', 5, 'Legacy one', 'PUBLISHED', '{}', '{}', '{}', '{}', false, now() - interval '5 days'),
        ('prj_e', NULL, 'legacy', 5, 'Legacy two', 'DRAFT', '{}', '{}', '{}', '{}', true, now() - interval '4 days');
      INSERT INTO tasks (id, project_id, kind, type, status) VALUES ('tsk_a', 'prj_a', 'worker', 'render', 'queued');
    `);
    for (const f of files.filter((f) => f >= "0005")) await run(f);

    const q = async (sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;
    expect(await q(`SELECT id, title, status FROM stories ORDER BY id`)).toEqual([
      { id: "old-story", title: "Old Story", status: "active" },
      { id: "unsorted", title: "Unsorted", status: "active" },
    ]);
    const rows = await q(`SELECT p.id, p.story_id, p.episode_number, p.version, p.archived, p.migrated, e.active_version_id = p.id AS active
      FROM projects p JOIN episodes e ON e.id = p.episode_id ORDER BY p.id`);
    expect(rows).toEqual([
      { id: "prj_a", story_id: "old-story", episode_number: 1, version: 1, archived: true, migrated: true, active: false },
      { id: "prj_b", story_id: "old-story", episode_number: 1, version: 2, archived: false, migrated: true, active: true },
      { id: "prj_c", story_id: "old-story", episode_number: 2, version: 1, archived: false, migrated: true, active: true },
      { id: "prj_d", story_id: "unsorted", episode_number: 1, version: 1, archived: false, migrated: true, active: true },
      { id: "prj_e", story_id: "unsorted", episode_number: 2, version: 1, archived: true, migrated: true, active: true },
    ]);
    expect(await q(`SELECT status FROM tasks WHERE id = 'tsk_a'`)).toEqual([{ status: "cancelled" }]);
    expect(await q(`SELECT project_id, episode_number FROM story_state_snapshots`)).toEqual([{ project_id: "prj_a", episode_number: 1 }]);
    expect(await q(`SELECT number, version_counter, migrated FROM episodes WHERE story_id = 'old-story' ORDER BY number`)).toEqual([
      { number: 1, version_counter: 2, migrated: true },
      { number: 2, version_counter: 1, migrated: true },
    ]);
    await pg.close();
  });
});

describe("silent cards, nulls and episode titles", () => {
  it("accepts story_bible_the_rising.json and episode_01_the_rising.json as pasted", async () => {
    const bible = await ok(fixture("story_bible_the_rising.json"));
    expect(bible.storyId).toBe("the-rising");

    const out = await ok(fixture("episode_01_the_rising.json"));
    const p = await version(out.projectId!);
    const ep = p.episode as Raw;
    expect(ep.episode_title).toBe("The Water Comes");
    expect(ep.youtube.title).toBe("The Rising Ep. 1: The Water Comes");
    expect(ep.youtube.category).toBe("Entertainment");
    const cards = ep.segments.filter((s: Raw) => s.silent);
    expect(cards.map((s: Raw) => s.id)).toEqual(["seg_001", "seg_003", "seg_004", "seg_008"]);
    for (const s of cards) expect(s).toMatchObject({ lines: null, narration: "" });
    expect(ep.segments[1].sfx[0].placement).toBe("segment_start");

    const tree = (await folderTree(db)).find((s) => s.id === "the-rising")!;
    expect(tree.episodes).toMatchObject([{ number: 1, title: "The Water Comes" }]);
  });

  it("a silent card with empty lines and no narration is valid; a spoken one is not", async () => {
    const ep = json("episode_1.json");
    delete ep.segments[0].narration;
    ep.segments[0].lines = [];
    const r = validateText(JSON.stringify(ep), { story: { bible: (await getStory(db, "rooftop-test"))!.bible as never, state: null } });
    expect(r.errors.map((e) => e.message)).toEqual([]);

    ep.segments[0].silent = false;
    const bad = validateText(JSON.stringify(ep));
    expect(bad.errors.map((e) => `${e.path_text} ${e.message}`)).toContain(
      'segments[0].narration seg_001: a segment that is not silent needs "narration" or at least one entry in "lines" (or set "silent": true).',
    );
  });

  it("null counts as missing on optional fields; required fields stay strict and name the segment and field", () => {
    const ep = json("episode_1.json");
    ep.segments[1].role = null;
    ep.segments[1].sfx = null;
    ep.youtube.tags = null;
    expect(validateText(JSON.stringify(ep)).errors).toEqual([]);

    ep.segments[1].scene.location_id = null;
    ep.segments[2].id = null;
    const messages = validateText(JSON.stringify(ep)).errors.map((e) => e.message);
    expect(messages.some((m) => m.startsWith("seg_002: scene.location_id: "))).toBe(true);
    expect(messages.some((m) => m.startsWith("segment 3: id: "))).toBe(true);
  });

  it("episode_title is required and non-empty, and duplicates in a story are a warning", async () => {
    const ep = json("episode_1.json");
    ep.episode_title = "  ";
    expect(validateText(JSON.stringify(ep)).errors.map((e) => e.message)).toContain('"episode_title" must not be empty.');
    ep.episode_title = null;
    const nullTitle = validateText(JSON.stringify(ep)).errors.map((e) => e.message);
    expect(nullTitle.filter((m) => m.includes("episode_title"))).toEqual(['"episode_title" is required in the 2.3 episode header.']);

    const second = json("episode_01_the_rising.json");
    second.episode_number = 2;
    second.segments[0].role = "main";
    const plan = await planIngest(db, JSON.stringify(second));
    expect(plan.warnings).toContain("episode_title 'The Water Comes' is already used by Episode 1 of this story. Episode titles should be unique.");
  });
});
