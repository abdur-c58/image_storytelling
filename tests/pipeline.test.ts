import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory://";
process.env.LOCAL_STORAGE_DIR = path.join(".data", "test-storage");

import { createAsset } from "@/lib/assets";
import type { Timeline } from "@/lib/crop/timeline";
import { getDb, type Db } from "@/lib/db";
import { projects, segments, stories, storyMasters, tasks, type TaskRow } from "@/lib/db/schema";
import type { StoryState } from "@/lib/episode/continuity";
import type { ImageItem } from "@/lib/episode/prompt";
import { StoredStoryBibleSchema, type Episode, type StoryBible } from "@/lib/episode/schema";
import { approveGate, deleteProject, redoMasterAndRetry, regenerateImage, retryFailed, suspectMasters } from "@/lib/pipeline/actions";
import { advance } from "@/lib/pipeline/advance";
import { onTaskCompleted } from "@/lib/pipeline/complete";
import { rerollCrops } from "@/lib/pipeline/crop";
import { ingestDocument } from "@/lib/pipeline/ingest";
import { hydrateTask } from "@/lib/pipeline/payloads";
import { assetKeys, orderedSegments, requirements } from "@/lib/pipeline/requirements";
import {
  advanceStory,
  approveAllGenerated,
  approveMaster,
  MASTER_PRIORITY,
  masterDemand,
  parkOnBadMasters,
  saveStory,
  supersetProblems,
} from "@/lib/pipeline/story";
import { completeTask, createTask, failTask, heartbeatTask, leaseNext, reapExpired } from "@/lib/queue";
import { getStorage, projectObjectPrefix } from "@/lib/storage";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const bibleRaw = () => JSON.parse(fixture("story_bible_example.json"));
const minimalRaw = () => JSON.parse(fixture("episode_minimal.json"));
const fullRaw = () => JSON.parse(fixture("episode_full.json"));

let db: Db;
beforeAll(async () => {
  db = await getDb();
  // The shared story runs without the masters gate; the gate has its own story below.
  const b = bibleRaw();
  b.automation.approval_gates.location_masters = false;
  await saveStory(db, StoredStoryBibleSchema.parse(b), JSON.stringify(b), []);
});

async function project(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row;
}

async function makeProject(raw: Record<string, unknown>, mutate?: (raw: Record<string, unknown>) => void): Promise<string> {
  mutate?.(raw);
  const out = await ingestDocument(db, JSON.stringify(raw));
  expect(out.validation.errors).toEqual([]);
  expect(out.error).toBeNull();
  return out.projectId!;
}

const ready = (owner: { projectId?: string | null; storyId?: string | null }, taskId: string | null, assetKey: string, contentType: string, meta: Record<string, unknown> = {}) =>
  createAsset(db, { ...owner, taskId, assetKey, contentType, status: "ready", meta });

/** A plausible aligned timeline: every spoken segment 12 s, words spread evenly over the voice. */
function fakeTimeline(ep: Episode): Timeline {
  return {
    fps: 30,
    segments: orderedSegments(ep).map((s, i) => {
      const spoken = !s.silent && !!s.narration.trim();
      const words = spoken ? s.narration.split(/\s+/) : [];
      const start = i * 12;
      return {
        id: s.id,
        type: s.type,
        start,
        end: start + 12,
        voice_start: spoken ? start : null,
        voice_duration: spoken ? 11 : null,
        display: s.type === "title_card" || s.type === "infographic" ? `card/${s.id}` : `image/${s.id}`,
        words: words.map((w, wi) => ({ word: w, start: start + (wi * 11) / words.length, end: start + ((wi + 0.8) * 11) / words.length })),
      };
    }),
  };
}

/** Pretend to be the worker/bot: produce every output a task is responsible for. */
async function fulfil(
  task: TaskRow,
  opts: { skipImages?: string[]; transcripts?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  const payload = task.payload as Record<string, unknown>;
  if (!task.projectId) {
    for (const item of payload.items as { asset_key: string }[]) await ready({ storyId: task.storyId }, task.id, item.asset_key, "image/png");
    return {};
  }
  const owner = { projectId: task.projectId };
  const [p] = await db.select().from(projects).where(eq(projects.id, task.projectId));
  const ep = p.episode as Episode;
  const req = requirements(ep);
  const pick = (ids: string[], key: string) => (Array.isArray(payload[key]) ? (payload[key] as string[]) : ids);
  switch (task.type) {
    case "generate_images":
      for (const item of payload.items as ImageItem[]) {
        if (opts.skipImages?.includes(item.segment_id)) continue;
        await ready(owner, task.id, item.asset_key, "image/png");
      }
      return { uploaded: (payload.items as ImageItem[]).length };
    case "voice": {
      const ids = pick(req.spoken, "segment_ids");
      for (const id of ids) await ready(owner, task.id, assetKeys.voice(id), "audio/flac");
      const lineWindows = (id: string) => {
        const ls = ep.segments.find((s) => s.id === id)?.lines ?? [];
        return ls.map((l, i) => ({ line_id: l.id, speaker: l.speaker, start: (i * 11) / ls.length, end: ((i + 1) * 11) / ls.length - 0.2, voice_effect: l.voice_effect }));
      };
      return {
        segments: ids.map((id) => ({ segment_id: id, duration_sec: 3, lines: lineWindows(id) })),
        usage: [{ provider: "fish", unit: "chars", quantity: 80 }],
      };
    }
    case "align": {
      const asset = await ready(owner, task.id, assetKeys.timeline, "application/json");
      await getStorage().put(asset.storageKey, new TextEncoder().encode(JSON.stringify(fakeTimeline(ep))), "application/json");
      const order = orderedSegments(ep);
      return {
        segments: order.map((s, i) => ({
          segment_id: s.id,
          start_sec: i * 12,
          end_sec: i * 12 + 12,
          wer: 0,
          transcript: opts.transcripts?.[s.id] ?? s.narration,
        })),
      };
    }
    case "sfx": {
      const ids = pick(req.cues.map((c) => c.cue_id), "cue_ids");
      for (const id of ids) {
        await ready(owner, task.id, assetKeys.sfx(id), "audio/flac", {
          provider: "openverse",
          title: `clip ${id}`,
          author: "someone",
          license: "by",
          license_url: "https://creativecommons.org/licenses/by/4.0/",
          source_url: `https://example.org/clip/${id}`,
          attribution_required: true,
        });
      }
      return { cues: [] };
    }
    case "cards":
      for (const id of pick(req.cards, "segment_ids")) await ready(owner, task.id, assetKeys.card(id), "image/png");
      return {};
    case "thumbnail_compose":
      for (const v of req.thumbnailVariants) await ready(owner, task.id, assetKeys.thumbnail(v), "image/jpeg");
      return {};
    case "mix":
      await ready(owner, task.id, assetKeys.mixAudio, "audio/wav");
      await ready(owner, task.id, assetKeys.mixReport, "application/json");
      await ready(owner, task.id, assetKeys.captions, "application/x-subrip");
      return { report: { integrated_lufs: -14.1 } };
    case "render":
      await ready(owner, task.id, assetKeys.video, "video/mp4");
      await ready(owner, task.id, assetKeys.preview, "video/mp4");
      return { duration_sec: ep.segments.length * 12 };
    case "upload_youtube":
      return { youtube_url: "https://youtu.be/abc123", video_id: "abc123" };
  }
  return {};
}

/** Drain both queues until nothing is leasable. Returns the types processed in order. */
async function drain(
  projectId: string,
  opts: { skipImages?: string[]; maxSteps?: number; transcripts?: Record<string, string>; types?: string[] } = {},
): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    // Retry pauses are real time; tests do not wait for them.
    await db.update(tasks).set({ availableAt: new Date(0) }).where(eq(tasks.status, "queued"));
    const task = (await leaseNext(db, "worker", "test-worker", 60, opts.types)) ?? (await leaseNext(db, "bot", "test-bot", 60, opts.types));
    if (!task) break;
    seen.push(task.type);
    const result = await fulfil(task, opts);
    await completeTask(db, task.id, task.leaseId!, result);
    await onTaskCompleted(db, task, result);
    if (task.storyId) await advanceStory(db, task.storyId);
    else await advance(db, projectId);
  }
  return seen;
}

async function clearQueue() {
  await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.status, "queued"));
}

describe("pipeline state machine", () => {
  it("runs the minimal fixture end to end to PUBLISHED", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw());
    expect((await project(id)).state).toBe("GENERATING");
    const seen = await drain(id);
    expect(seen).toContain("generate_images");
    expect(seen).toContain("render");
    expect(seen.at(-1)).toBe("upload_youtube");
    expect(seen.indexOf("align")).toBeGreaterThan(seen.indexOf("voice"));
    expect(seen.indexOf("mix")).toBeGreaterThan(seen.indexOf("align"));
    const p = await project(id);
    expect(p.state).toBe("PUBLISHED");
    expect(p.storyId).toBe("rooftop-test");
    expect(p.youtubeVideoId).toBe("abc123");
    const outputs = p.outputs as { description: string };
    expect(outputs.description).toContain("Sound effects:");
    expect(outputs.description).toContain("CC BY 4.0");
    expect(outputs.description).not.toContain("{{sfx_credits}}");
    const segRows = await db.select().from(segments).where(eq(segments.projectId, id));
    const seg2 = segRows.find((s) => s.segmentId === "seg_002")!;
    expect(seg2.finalPrompt).toContain("Flat 2D cartoon");
    expect((seg2.promptParts as { kind: string }[]).map((x) => x.kind)).toContain("anchor");
    expect(seg2.masterKeys).toEqual(["loc/rooftop/clear/a", "char/protagonist/beanie"]);
  });

  it("does nothing while in DRAFT and starts on demand", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw(), (raw) => {
      raw.automation = { auto_start_on_submit: false };
    });
    expect((await project(id)).state).toBe("DRAFT");
    expect(await leaseNext(db, "bot", "b", 60)).toBeNull();
  });

  it("stops at the publish gate until approved", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw(), (raw) => {
      raw.automation = { approval_gates: { before_render: false, before_publish: true } };
    });
    const seen = await drain(id);
    expect(seen).not.toContain("upload_youtube");
    const p = await project(id);
    expect(p.state).toBe("REVIEW");
    expect(p.stateDetail).toMatch(/publish approval/);
    await approveGate(db, id, "publish");
    expect(await drain(id)).toEqual(["upload_youtube"]);
    expect((await project(id)).state).toBe("PUBLISHED");
  });

  it("re-requests a finished batch's missing images while another batch is still running", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw());
    const [batch] = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.scope, "batch:01"))));
    const [segX, segY] = (batch.payload as { items: ImageItem[] }).items.map((i) => i.segment_id);
    await regenerateImage(db, id, segY);
    await db.update(tasks).set({ status: "leased" }).where(and(eq(tasks.projectId, id), like(tasks.scope, "regen:%")));

    const task = (await leaseNext(db, "bot", "test-bot", 60, ["generate_images"]))!;
    expect(task.scope).toBe("batch:01");
    const result = await fulfil(task, { skipImages: [segX] });
    await completeTask(db, task.id, task.leaseId!, result);
    await onTaskCompleted(db, task, result);
    await advance(db, id);

    const retry = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.status, "queued")))).filter((t) =>
      t.scope.startsWith("retry"),
    );
    expect(retry.flatMap((t) => (t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id))).toEqual([segX]);
    await db.update(tasks).set({ status: "cancelled" }).where(and(eq(tasks.projectId, id), like(tasks.scope, "regen:%")));
  });

  it("retries only missing images and fails after the attempt limit", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw());
    await drain(id, { skipImages: ["seg_006"] });
    const p = await project(id);
    expect(p.state).toBe("FAILED");
    expect(p.stateDetail).toMatch(/Images still missing after 3 attempts: seg_006/);
    // Everything that does not need seg_006 still ran.
    const types = new Set((await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.status, "done")))).map((t) => t.type));
    for (const t of ["voice", "align", "mix", "cards"]) expect(types.has(t)).toBe(true);
    const imageTasks = (await db.select().from(tasks).where(eq(tasks.projectId, id))).filter(
      (t) => t.type === "generate_images" && t.scope.startsWith("retry"),
    );
    expect(imageTasks.length).toBeGreaterThan(0);
    for (const t of imageTasks) {
      expect((t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id)).toEqual(["seg_006"]);
    }
    expect((await db.select().from(tasks).where(eq(tasks.projectId, id))).some((t) => t.type === "render")).toBe(false);

    await retryFailed(db, id);
    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");
  });

  it("a dead image batch is dropped, not redone, once its image is regenerated", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw());
    await drain(id, { skipImages: ["seg_002"], types: ["generate_images"], maxSteps: 1 });
    await db.update(tasks).set({ availableAt: new Date(0) }).where(eq(tasks.status, "queued"));
    const retry = (await leaseNext(db, "bot", "test-bot", 60, ["generate_images"]))!;
    expect(retry.scope).toMatch(/^retry/);
    await failTask(db, retry.id, retry.leaseId!, "the master itself has a letter H", false);
    await advance(db, id);
    expect((await project(id)).state).toBe("FAILED");

    await regenerateImage(db, id, "seg_002");
    const [old] = await db.select().from(tasks).where(eq(tasks.id, retry.id));
    expect(old.status).toBe("superseded");
    await drain(id);
    const p = await project(id);
    expect(p.state).not.toBe("FAILED");
    const redone = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images"), eq(tasks.status, "done"))))
      .filter((t) => t.scope.startsWith("retry"));
    expect(redone).toHaveLength(0);
  });

  it("regenerating an image re-renders but does not redo voice", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw(), (raw) => {
      raw.automation = { approval_gates: { before_render: false, before_publish: true } };
    });
    await drain(id);
    await regenerateImage(db, id, "seg_002");
    const seen = await drain(id);
    expect(seen).toContain("generate_images");
    expect(seen).toContain("render");
    expect(seen).not.toContain("voice");
    expect(seen).not.toContain("mix");
    expect((await project(id)).state).toBe("REVIEW");
  });

  it("requeues expired leases with backoff and dead-letters exhausted tasks", async () => {
    await clearQueue();
    const id = await makeProject(minimalRaw());
    const task = (await leaseNext(db, "bot", "bot-a", 60))!;
    expect(task.type).toBe("generate_images");
    expect(await heartbeatTask(db, task.id, "wrong-lease", 60)).toBeNull();
    expect(await heartbeatTask(db, task.id, task.leaseId!, 60, { completed_items: 1, total_items: 1 })).not.toBeNull();

    await db.update(tasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(tasks.id, task.id));
    expect(await reapExpired(db)).toContainEqual({ projectId: id, storyId: null });
    const [requeued] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(requeued.status).toBe("queued");
    expect(requeued.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await completeTask(db, task.id, task.leaseId!, {})).toBeNull();

    await db.update(tasks).set({ availableAt: new Date(0) }).where(eq(tasks.id, task.id));
    const again = (await leaseNext(db, "bot", "bot-b", 60))!;
    expect(again.id).toBe(task.id);
    await failTask(db, again.id, again.leaseId!, "Flow refused the prompt", false);
    await advance(db, id);
    const p = await project(id);
    expect(p.state).toBe("FAILED");
    expect(p.stateDetail).toMatch(/Flow refused/);
  });

  it("deletes a project with its files and rows, leaving other projects alone", async () => {
    await clearQueue();
    const doomed = await makeProject(minimalRaw());
    const kept = await makeProject(minimalRaw());
    const storage = getStorage();
    const video = { taskId: null, assetKey: assetKeys.video, contentType: "video/mp4", status: "ready" } as const;
    const doomedAsset = await createAsset(db, { ...video, projectId: doomed });
    const keptAsset = await createAsset(db, { ...video, projectId: kept });
    await storage.put(doomedAsset.storageKey, new Uint8Array([1, 2, 3]), "video/mp4");
    await storage.put(keptAsset.storageKey, new Uint8Array([4, 5, 6]), "video/mp4");

    const { filesDeleted } = await deleteProject(db, doomed);
    expect(filesDeleted).toBe(1);
    expect(await project(doomed)).toBeUndefined();
    expect(await db.select().from(tasks).where(eq(tasks.projectId, doomed))).toEqual([]);
    expect(await db.select().from(segments).where(eq(segments.projectId, doomed))).toEqual([]);
    expect(await storage.head(doomedAsset.storageKey)).toBeNull();
    expect(await storage.head(keptAsset.storageKey)).toBe(3);
    expect(await project(kept)).toBeDefined();
    await expect(deleteProject(db, doomed)).rejects.toThrow(/not found/);
    expect(() => projectObjectPrefix("../other")).toThrow();
  });
});

describe("stories (schema 2.0)", () => {
  it("rejects an episode whose story is unknown", async () => {
    const raw = minimalRaw();
    raw.story_id = "nobody";
    const out = await ingestDocument(db, JSON.stringify(raw));
    expect(out.error).toMatch(/Story "nobody" does not exist yet/);
  });

  it("only accepts supersets of a story bible once episodes exist", async () => {
    const b = bibleRaw();
    b.automation.approval_gates.location_masters = false;
    b.scene_bible.locations = b.scene_bible.locations.filter((l: { id: string }) => l.id !== "apartment");
    await expect(saveStory(db, StoredStoryBibleSchema.parse(b), JSON.stringify(b), [])).rejects.toThrow(/location apartment was removed/);
  });

  it("gates episode images on approved masters and passes them as references", async () => {
    await clearQueue();
    const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: bibleRaw(), episode: minimalRaw() };
    bundle.story_bible.story_id = "gated-story";
    bundle.episode.story_id = "gated-story";
    const out = await ingestDocument(db, JSON.stringify(bundle));
    expect(out.error).toBeNull();
    const id = out.projectId!;
    const [story] = await db.select().from(stories).where(eq(stories.id, "gated-story"));
    expect(story.state).toBe("LOCATION_MASTERS_REQUESTED");
    const masters = await db.select().from(storyMasters).where(eq(storyMasters.storyId, "gated-story"));
    expect(masters).toHaveLength(13);
    expect((await project(id)).state).toBe("WAITING_MASTERS");

    // Worker stages run meanwhile; episode images do not.
    const early = await drain(id, { types: ["voice", "sfx", "cards", "align", "mix", "generate_location_master", "generate_character_group_master"] });
    expect(early).toContain("generate_location_master");
    expect(early).toContain("voice");
    expect(early).not.toContain("generate_images");
    const [reviewing] = await db.select().from(stories).where(eq(stories.id, "gated-story"));
    expect(reviewing.state).toBe("MASTERS_REVIEW");
    expect((await project(id)).state).toBe("WAITING_MASTERS");

    // Only the masters this episode uses are made; the rest wait for an episode that needs them.
    const needed = await masterDemand(db, "gated-story");
    expect(needed.size).toBeGreaterThan(0);
    expect(needed.size).toBeLessThan(13);
    const masterTasks = await db.select().from(tasks).where(and(eq(tasks.storyId, "gated-story"), eq(tasks.type, "generate_location_master")));
    expect(masterTasks.every((t) => t.priority === MASTER_PRIORITY)).toBe(true);
    expect(await approveAllGenerated(db, "gated-story")).toBe(needed.size);
    const [approved] = await db.select().from(stories).where(eq(stories.id, "gated-story"));
    expect(approved.state).toBe("MASTERS_APPROVED");
    expect(approved.stateDetail).toMatch(/not needed by any episode yet/);
    const idle = await db.select().from(storyMasters).where(eq(storyMasters.storyId, "gated-story"));
    expect(idle.filter((m) => !needed.has(m.masterKey)).every((m) => m.status === "missing")).toBe(true);

    const imageTask = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images"))))[0];
    expect(imageTask).toBeDefined();
    const hydrated = (await hydrateTask(db, imageTask, "https://site.test")) as { payload: { items: { reference_images: { master_key: string }[]; reference_image_urls: string[] }[] } };
    const segItem = hydrated.payload.items.find((i) => i.reference_images.length)!;
    expect(segItem.reference_images.map((r) => r.master_key)).toContain("loc/rooftop/clear/a");
    expect(segItem.reference_image_urls[0]).toMatch(/^https:\/\/site\.test\/api\/bot\/assets\//);

    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");
  });

  it("merges bible_additions into the story so their masters are made, and re-imports cleanly", async () => {
    await clearQueue();
    const raw = fullRaw();
    raw.story_id = "gated-story";
    const text = JSON.stringify(raw);
    const out = await ingestDocument(db, text);
    expect(out.error).toBeNull();
    const id = out.projectId!;
    const keys = (await db.select().from(storyMasters).where(eq(storyMasters.storyId, "gated-story"))).map((m) => m.masterKey);
    expect(keys).toContain("loc/rooftop/clear/c");
    expect(keys).toContain("char/protagonist/bandaged");
    expect((await project(id)).state).toBe("WAITING_MASTERS");

    await drain(id, { types: ["voice", "sfx", "cards", "align", "mix", "generate_location_master", "generate_character_group_master"] });
    expect(await approveAllGenerated(db, "gated-story")).toBeGreaterThan(0);
    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");

    const again = await ingestDocument(db, text);
    expect(again.validation.errors).toEqual([]);
  });

  it("starts images for segments whose masters are approved while the rest wait", async () => {
    await clearQueue();
    const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: bibleRaw(), episode: fullRaw() };
    bundle.story_bible.story_id = "partial-story";
    bundle.episode.story_id = "partial-story";
    const out = await ingestDocument(db, JSON.stringify(bundle));
    expect(out.error).toBeNull();
    const id = out.projectId!;
    await drain(id, { types: ["generate_location_master", "generate_character_group_master"] });

    const segs = await db.select().from(segments).where(eq(segments.projectId, id));
    const keyed = segs.filter((s) => (s.masterKeys as string[]).length);
    const approved = new Set(keyed[0].masterKeys as string[]);
    for (const k of approved) await approveMaster(db, "partial-story", k);

    const imageTasks = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images")))).filter(
      (t) => !t.scope.startsWith("thumbnail"),
    );
    const asked = new Set(imageTasks.flatMap((t) => (t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id)));
    const ready = segs.filter((s) => (s.masterKeys as string[]).every((k) => approved.has(k))).map((s) => s.segmentId);
    const blocked = segs.filter((s) => !(s.masterKeys as string[]).every((k) => approved.has(k))).map((s) => s.segmentId);
    expect(asked.has(keyed[0].segmentId)).toBe(true);
    expect(blocked.length).toBeGreaterThan(0);
    for (const s of blocked) expect(asked.has(s)).toBe(false);
    for (const s of ready.filter((r) => segs.find((x) => x.segmentId === r)!.finalPrompt)) expect(asked.has(s)).toBe(true);
    expect((await project(id)).state).toBe("WAITING_MASTERS");
  });

  it("an image task that reports a broken master parks its images until the master is redone", async () => {
    await clearQueue();
    const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: bibleRaw(), episode: fullRaw() };
    bundle.story_bible.story_id = "bad-master-story";
    bundle.episode.story_id = "bad-master-story";
    const out = await ingestDocument(db, JSON.stringify(bundle));
    const id = out.projectId!;
    await drain(id, { types: ["generate_location_master", "generate_character_group_master"] });
    await approveAllGenerated(db, "bad-master-story");

    await db.update(tasks).set({ availableAt: new Date(0) }).where(eq(tasks.status, "queued"));
    let task: TaskRow | null = null;
    while (!task || (task.payload as { purpose?: string }).purpose === "thumbnail") {
      task = await leaseNext(db, "bot", "test-bot", 60, ["generate_images"]);
      if (!task) throw new Error("no image task");
    }
    const items = (task.payload as { items: ImageItem[] }).items;
    const bad = items.find((i) => i.master_keys.some((k) => k.startsWith("loc/")))!.master_keys.find((k) => k.startsWith("loc/"))!;

    const ignored = await parkOnBadMasters(db, task, task.leaseId!, "x", [{ master_key: "loc/not/used/here", reason: "x" }]);
    expect(ignored).toBeNull();
    const sent = await parkOnBadMasters(db, task, task.leaseId!, "helipad has an H", [{ master_key: bad, reason: "Readable H on the helipad." }]);
    expect(sent).toEqual([bad]);
    await advance(db, id);

    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].status).toBe("superseded");
    const [master] = await db.select().from(storyMasters).where(and(eq(storyMasters.storyId, "bad-master-story"), eq(storyMasters.masterKey, bad)));
    expect(master.status).toBe("requested");
    const regen = (await db.select().from(tasks).where(and(eq(tasks.storyId, "bad-master-story"), like(tasks.scope, `regen:${bad}:%`))))[0];
    expect((regen.payload as { items: { fix_note?: string }[] }).items[0].fix_note).toBe("Readable H on the helipad.");

    const blocked = items.filter((i) => i.master_keys.includes(bad)).map((i) => i.segment_id);
    const queuedFor = async () =>
      new Set(
        (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images"), inArray(tasks.status, ["queued", "leased"]))))
          .flatMap((t) => (t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id)),
      );
    for (const s of blocked) expect((await queuedFor()).has(s)).toBe(false);
    expect((await project(id)).state).not.toBe("FAILED");

    await drain(id, { types: ["generate_location_master"] });
    await approveMaster(db, "bad-master-story", bad);
    const after = await queuedFor();
    for (const s of blocked) expect(after.has(s)).toBe(true);
  });

  it("'Redo master & retry' regenerates the master a dead image task names, then resumes its images", async () => {
    await clearQueue();
    const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: bibleRaw(), episode: fullRaw() };
    bundle.story_bible.story_id = "redo-master-story";
    bundle.episode.story_id = "redo-master-story";
    const id = (await ingestDocument(db, JSON.stringify(bundle))).projectId!;
    await drain(id, { types: ["generate_location_master", "generate_character_group_master"] });
    await approveAllGenerated(db, "redo-master-story");

    await db.update(tasks).set({ availableAt: new Date(0) }).where(eq(tasks.status, "queued"));
    let task: TaskRow | null = null;
    while (!task || (task.payload as { purpose?: string }).purpose === "thumbnail") {
      task = await leaseNext(db, "bot", "test-bot", 60, ["generate_images"]);
      if (!task) throw new Error("no image task");
    }
    const items = (task.payload as { items: ImageItem[] }).items;
    const bad = items.flatMap((i) => i.master_keys).find((k) => k.startsWith("loc/"))!;
    await failTask(db, task.id, task.leaseId!, `the master ${bad} has a letter H`, false);
    await advance(db, id);
    expect((await project(id)).state).toBe("FAILED");

    const dead = await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.status, "dead")));
    expect(suspectMasters(dead)).toEqual([bad]);
    await redoMasterAndRetry(db, id, bad);

    const [master] = await db.select().from(storyMasters).where(and(eq(storyMasters.storyId, "redo-master-story"), eq(storyMasters.masterKey, bad)));
    expect(master.status).toBe("requested");
    const regen = (await db.select().from(tasks).where(and(eq(tasks.storyId, "redo-master-story"), like(tasks.scope, `regen:${bad}:%`))))[0];
    expect((regen.payload as { items: { fix_note?: string }[] }).items[0].fix_note).toMatch(/letter H/);
    expect((await project(id)).state).not.toBe("FAILED");

    const blocked = items.filter((i) => i.master_keys.includes(bad)).map((i) => i.segment_id);
    await drain(id, { types: ["generate_location_master"] });
    await approveMaster(db, "redo-master-story", bad);
    const queued = new Set(
      (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images"), eq(tasks.status, "queued"))))
        .flatMap((t) => (t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id)),
    );
    for (const s of blocked) expect(queued.has(s)).toBe(true);
  });

  it("a dead task stops only the stages that need it", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw());
    await db.update(tasks).set({ status: "dead", error: "boom" }).where(and(eq(tasks.projectId, id), eq(tasks.type, "cards")));
    await db.update(tasks).set({ status: "cancelled" }).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images")));
    await advance(db, id);
    const live = await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.status, "queued")));
    expect(live.some((t) => t.type === "generate_images")).toBe(true);
    expect(live.some((t) => t.type === "cards")).toBe(false);
    const p = await project(id);
    expect(p.state).toBe("FAILED");
    expect(p.stateDetail).toMatch(/cards\(all\): boom/);
  });

  it("withdraws queued master batches no episode needs, but leaves a leased one alone", async () => {
    await clearQueue();
    const b = bibleRaw();
    b.story_id = "idle-story";
    await saveStory(db, StoredStoryBibleSchema.parse(b), JSON.stringify(b), []);
    expect(await db.select().from(tasks).where(eq(tasks.storyId, "idle-story"))).toEqual([]);

    const rows = await db.select().from(storyMasters).where(eq(storyMasters.storyId, "idle-story"));
    const legacy = (keys: string[], scope: string) =>
      createTask(db, { storyId: "idle-story", kind: "bot", type: "generate_location_master", scope, priority: 11, payload: { items: keys.map((k) => ({ master_key: k })) } });
    const queued = await legacy(rows.slice(0, 8).map((r) => r.masterKey), "masters:01");
    const leased = await legacy(rows.slice(8, 10).map((r) => r.masterKey), "masters:02");
    await db.update(tasks).set({ status: "leased" }).where(eq(tasks.id, leased.id));
    await db.update(storyMasters).set({ status: "requested", attempts: 1 }).where(eq(storyMasters.storyId, "idle-story"));

    await advanceStory(db, "idle-story");
    const after = await db.select().from(tasks).where(eq(tasks.storyId, "idle-story"));
    expect(after.find((t) => t.id === queued.id)!.status).toBe("cancelled");
    expect(after.find((t) => t.id === leased.id)!.status).toBe("leased");
    expect(after.filter((t) => t.status === "queued")).toEqual([]);
    const masters = new Map((await db.select().from(storyMasters).where(eq(storyMasters.storyId, "idle-story"))).map((m) => [m.masterKey, m]));
    expect(masters.get(rows[0].masterKey)).toMatchObject({ status: "missing", attempts: 0 });
    expect(masters.get(rows[8].masterKey)!.status).toBe("requested");
    await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, leased.id));
  });

  it("writes a crop plan after align, and a re-roll redoes only the render", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw(), (raw) => {
      (raw as { automation: unknown }).automation = { approval_gates: { before_render: false, before_publish: true } };
    });
    await drain(id);
    const p = await project(id);
    const crop = (p.outputs as { crop: { segments: Record<string, { sentences: unknown[]; crop_plan: { kind: string; amount: number }[] }> } }).crop;
    expect(crop.segments.seg_006.sentences).toHaveLength(6);
    expect(crop.segments.seg_002.crop_plan).toEqual([]);
    const crops = Object.values(crop.segments).flatMap((s) => s.crop_plan).filter((k) => k.kind === "crop");
    expect(crops.length).toBeGreaterThan(0);
    for (const k of crops) expect(k.amount).toBeLessThanOrEqual(0.2);

    const before = JSON.stringify(crop.segments.seg_006.crop_plan);
    await rerollCrops(db, id, "seg_006");
    const after = (await project(id)).outputs as typeof p.outputs & { crop: typeof crop };
    expect(JSON.stringify(after.crop.segments.seg_006.crop_plan)).not.toBe(before);
    expect(JSON.stringify(after.crop.segments.seg_004.crop_plan)).toBe(JSON.stringify(crop.segments.seg_004.crop_plan));
    expect(await drain(id)).toEqual(["render"]);
  });

  it("commits the story state when an episode is published", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw());
    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");
    const [story] = await db.select().from(stories).where(eq(stories.id, "rooftop-test"));
    const state = story.storyState as StoryState;
    expect(state.by_episode["1"].locations).toEqual({ rooftop: "barricaded", apartment: "ransacked" });
    expect(state.committed_through_episode).toBe(1);
  });

  it("switches a segment to split-and-silence when tag words are spoken twice", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw(), (raw) => {
      (raw as { automation: unknown }).automation = { approval_gates: { before_render: true, before_publish: true } };
    });
    const leaky = { seg_003: "From up here, the streets looked like a model town. Long pause. Nothing moved at all." };
    await drain(id, { transcripts: leaky });
    let [row] = await db.select().from(segments).where(and(eq(segments.projectId, id), eq(segments.segmentId, "seg_003")));
    expect((row.qa as { tag_leak: string[] }).tag_leak).toEqual(["long", "pause"]);
    expect(row.voiceMode).toBe("normal");

    const { regenerateVoice } = await import("@/lib/pipeline/actions");
    await regenerateVoice(db, id, "seg_003");
    await drain(id, { transcripts: leaky });
    [row] = await db.select().from(segments).where(and(eq(segments.projectId, id), eq(segments.segmentId, "seg_003")));
    expect(row.voiceMode).toBe("split_and_silence");
    const voiceTasks = await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "voice")));
    const last = voiceTasks.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const hydrated = (await hydrateTask(db, last, "https://site.test")) as { payload: { voice_modes: Record<string, string> } };
    expect(hydrated.payload.voice_modes.seg_003).toBe("split_and_silence");
  });
});

describe("schema 2.1: dialogue and channel cast", () => {
  it("stores line timings and tags crop sentences with speakers", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw(), (raw) => {
      (raw as { automation: unknown }).automation = { approval_gates: { before_render: false, before_publish: true } };
    });
    await drain(id);
    const [row] = await db.select().from(segments).where(and(eq(segments.projectId, id), eq(segments.segmentId, "seg_010")));
    expect((row.lineTimings as { line_id: string }[]).map((l) => l.line_id)).toEqual(["seg_010_l1", "seg_010_l2", "seg_010_l3"]);
    const crop = (await project(id)).outputs as { crop: { segments: Record<string, { sentences: { speaker?: string }[] }> } };
    expect(crop.crop.segments.seg_010.sentences.map((s) => s.speaker)).toContain("mara");
    expect(crop.crop.segments.seg_002.sentences.every((s) => s.speaker === "narrator")).toBe(true);
    const voiceTask = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "voice"))))[0];
    const hydrated = (await hydrateTask(db, voiceTask, "https://site.test")) as { payload: { episode: Episode } };
    expect(Object.keys(hydrated.payload.episode.voices).sort()).toEqual(["dex", "mara", "narrator"]);
  });

  it("applies voice ids entered on the website to voice tasks and voice tests", async () => {
    await clearQueue();
    const { saveVoiceSettings, setStoryVoice, storyVoices } = await import("@/lib/pipeline/voices");
    const { requestVoiceSample } = await import("@/lib/pipeline/story");
    await saveVoiceSettings(db, { default_voice_id: "site-default", channel: { mara: "site-mara", dex: "ignored-not-channel" } });
    await setStoryVoice(db, "rooftop-test", "dex", "story-dex");
    await expect(setStoryVoice(db, "rooftop-test", "dex", "bad id!")).rejects.toThrow(/letters, digits/);

    const { voices, sources } = await storyVoices(db, "rooftop-test");
    expect(voices.narrator.voice_id).toBe("site-default");
    expect(voices.mara.voice_id).toBe("site-mara");
    expect(voices.dex.voice_id).toBe("story-dex");
    expect(sources).toEqual({ narrator: "default_settings", mara: "channel_settings", dex: "story_page" });

    const id = await makeProject(minimalRaw());
    const voiceTask = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "voice"))))[0];
    const hydrated = (await hydrateTask(db, voiceTask, "https://site.test")) as { payload: { episode: Episode } };
    expect(hydrated.payload.episode.voices.narrator.voice_id).toBe("site-default");
    expect(hydrated.payload.episode.voices.dex.voice_id).toBe("story-dex");

    await requestVoiceSample(db, "rooftop-test", "mara");
    const [sample] = await db.select().from(tasks).where(and(eq(tasks.storyId, "rooftop-test"), eq(tasks.type, "voice_sample")));
    expect((sample.payload as { voice: { voice_id: string } }).voice.voice_id).toBe("site-mara");

    await setStoryVoice(db, "rooftop-test", "dex", "");
    await saveVoiceSettings(db, { default_voice_id: "", channel: {} });
    const after = await storyVoices(db, "rooftop-test");
    expect(after.voices.dex.voice_id).toBe("test-voice-dex");
    expect(after.sources.narrator).toBe("worker_env");
  });

  it("registers channel characters, expands refs in a later story and reuses approved sheets", async () => {
    await clearQueue();
    const { approveMaster, masterCandidates } = await import("@/lib/pipeline/story");
    const { loadCastRegistry } = await import("@/lib/pipeline/cast");
    const origin = bibleRaw();
    origin.story_id = "cast-origin";
    const first = await ingestDocument(db, JSON.stringify(origin));
    expect(first.error).toBeNull();
    const registry = await loadCastRegistry(db);
    expect(registry.get("mara")?.origin_story_id).toBe("rooftop-test");

    // Approve Mara's sheet in the story that defined her, so later stories start from it.
    const sheet = await ready({ storyId: "rooftop-test" }, null, "master/char/mara/default", "image/png");
    await getStorage().put(sheet.storageKey, new Uint8Array([1, 2, 3]), "image/png");
    await approveMaster(db, "rooftop-test", "char/mara/default", sheet.id);

    const second = await ingestDocument(db, fixture("story_bible_second.json"));
    expect(second.validation.errors).toEqual([]);
    expect(second.error).toBeNull();
    const [story] = await db.select().from(stories).where(eq(stories.id, "harbour-test"));
    const mara = (story.bible as StoryBible).characters.find((c) => c.id === "mara")!;
    expect(mara.visual_description).toBe("a tall stick figure with a black ponytail and round glasses");
    expect(mara.outfit_states.map((o) => o.id)).toEqual(["default", "wetsuit"]);
    const [reused] = await db
      .select()
      .from(storyMasters)
      .where(and(eq(storyMasters.storyId, "harbour-test"), eq(storyMasters.masterKey, "char/mara/default")));
    expect(reused.status).toBe("approved");
    const copies = await masterCandidates(db, "harbour-test", "char/mara/default");
    expect(copies[0].storageKey).not.toBe(sheet.storageKey);

    const changed = JSON.parse(fixture("story_bible_second.json"));
    changed.characters[0] = { ...bibleRaw().characters[1], visual_description: "short, red hair" };
    const rejected = await ingestDocument(db, JSON.stringify(changed));
    expect(rejected.error).toMatch(/Channel character "mara" can't be changed by this story/);
  });

  it("promotes a story character to the channel cast, never back", async () => {
    const { promoteCharacter } = await import("@/lib/pipeline/story");
    const { loadCastRegistry } = await import("@/lib/pipeline/cast");
    await promoteCharacter(db, "harbour-test", "harbourmaster");
    expect((await loadCastRegistry(db)).get("harbourmaster")?.origin_story_id).toBe("harbour-test");
    await expect(promoteCharacter(db, "harbour-test", "harbourmaster")).rejects.toThrow(/already in the channel cast/);

    const [story] = await db.select().from(stories).where(eq(stories.id, "harbour-test"));
    const b = StoredStoryBibleSchema.parse(story.bible);
    const demoted = structuredClone(b);
    demoted.characters.find((c) => c.id === "harbourmaster")!.scope = "story";
    expect(supersetProblems(b, demoted)).toContain("character harbourmaster went from channel to story scope (only story → channel is allowed)");
  });

  it("queues group master sheets as their own bot task", async () => {
    const all = await db.select().from(tasks).where(eq(tasks.type, "generate_character_group_master"));
    expect(all.length).toBeGreaterThan(0);
    const payload = all[0].payload as { purpose: string; items: { master_key: string }[] };
    expect(payload.purpose).toBe("character_group_masters");
    expect(payload.items.every((i) => i.master_key.startsWith("group/"))).toBe(true);
  });
});
