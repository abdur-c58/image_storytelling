import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory://";
process.env.LOCAL_STORAGE_DIR = path.join(".data", "test-storage");

import { createAsset } from "@/lib/assets";
import type { Timeline } from "@/lib/crop/timeline";
import { getDb, type Db } from "@/lib/db";
import { projects, segments, stories, storyMasters, tasks, type TaskRow } from "@/lib/db/schema";
import type { StoryState } from "@/lib/episode/continuity";
import type { ImageItem } from "@/lib/episode/prompt";
import { StoryBibleSchema, type Episode } from "@/lib/episode/schema";
import { approveGate, deleteProject, regenerateImage, retryFailed } from "@/lib/pipeline/actions";
import { advance } from "@/lib/pipeline/advance";
import { onTaskCompleted } from "@/lib/pipeline/complete";
import { rerollCrops } from "@/lib/pipeline/crop";
import { ingestDocument } from "@/lib/pipeline/ingest";
import { hydrateTask } from "@/lib/pipeline/payloads";
import { assetKeys, orderedSegments, requirements } from "@/lib/pipeline/requirements";
import { advanceStory, approveAllGenerated, saveStory } from "@/lib/pipeline/story";
import { completeTask, failTask, heartbeatTask, leaseNext, reapExpired } from "@/lib/queue";
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
  await saveStory(db, StoryBibleSchema.parse(b), JSON.stringify(b), []);
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
      return { segments: ids.map((id) => ({ segment_id: id, duration_sec: 3 })), usage: [{ provider: "fish", unit: "chars", quantity: 80 }] };
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

  it("retries only missing images and fails after the attempt limit", async () => {
    await clearQueue();
    const id = await makeProject(fullRaw());
    await drain(id, { skipImages: ["seg_006"] });
    const p = await project(id);
    expect(p.state).toBe("FAILED");
    expect(p.error).toMatch(/seg_006/);
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
    await expect(saveStory(db, StoryBibleSchema.parse(b), JSON.stringify(b), [])).rejects.toThrow(/location apartment was removed/);
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
    expect(masters).toHaveLength(11);
    expect((await project(id)).state).toBe("WAITING_MASTERS");

    // Worker stages run meanwhile; episode images do not.
    const early = await drain(id, { types: ["voice", "sfx", "cards", "align", "mix", "generate_location_master"] });
    expect(early).toContain("generate_location_master");
    expect(early).toContain("voice");
    expect(early).not.toContain("generate_images");
    const [reviewing] = await db.select().from(stories).where(eq(stories.id, "gated-story"));
    expect(reviewing.state).toBe("MASTERS_REVIEW");
    expect((await project(id)).state).toBe("WAITING_MASTERS");

    expect(await approveAllGenerated(db, "gated-story")).toBe(11);
    const [approved] = await db.select().from(stories).where(eq(stories.id, "gated-story"));
    expect(approved.state).toBe("MASTERS_APPROVED");

    const imageTask = (await db.select().from(tasks).where(and(eq(tasks.projectId, id), eq(tasks.type, "generate_images"))))[0];
    expect(imageTask).toBeDefined();
    const hydrated = (await hydrateTask(db, imageTask, "https://site.test")) as { payload: { items: { reference_images: { master_key: string }[]; reference_image_urls: string[] }[] } };
    const segItem = hydrated.payload.items.find((i) => i.reference_images.length)!;
    expect(segItem.reference_images.map((r) => r.master_key)).toContain("loc/rooftop/clear/a");
    expect(segItem.reference_image_urls[0]).toMatch(/^https:\/\/site\.test\/api\/bot\/assets\//);

    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");
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
