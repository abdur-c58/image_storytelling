import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory://";
process.env.LOCAL_STORAGE_DIR = path.join(".data", "test-storage");

import { createAsset } from "@/lib/assets";
import { getDb, type Db } from "@/lib/db";
import { projects, segments, tasks, type TaskRow } from "@/lib/db/schema";
import type { ImageItem } from "@/lib/episode/prompt";
import type { Episode } from "@/lib/episode/schema";
import { validateEpisodeText } from "@/lib/episode/validate";
import { approveGate, deleteProject, regenerateImage, retryFailed } from "@/lib/pipeline/actions";
import { advance } from "@/lib/pipeline/advance";
import { onTaskCompleted } from "@/lib/pipeline/complete";
import { createProject } from "@/lib/pipeline/project";
import { assetKeys, requirements } from "@/lib/pipeline/requirements";
import { completeTask, failTask, heartbeatTask, leaseNext, reapExpired } from "@/lib/queue";
import { getStorage, projectObjectPrefix } from "@/lib/storage";

const minimalText = readFileSync(path.join(__dirname, "..", "fixtures", "minimal_3_segments.json"), "utf8");
const fullText = readFileSync(path.join(__dirname, "..", "fixtures", "full_example.json"), "utf8");

let db: Db;
beforeAll(async () => {
  db = await getDb();
});

async function project(id: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row;
}

async function makeProject(text: string, mutate?: (raw: Record<string, unknown>) => void): Promise<string> {
  const raw = JSON.parse(text);
  mutate?.(raw);
  const json = JSON.stringify(raw);
  const result = validateEpisodeText(json);
  expect(result.errors).toEqual([]);
  return createProject(db, json, result);
}

const ready = (projectId: string, taskId: string, assetKey: string, contentType: string, meta: Record<string, unknown> = {}) =>
  createAsset(db, { projectId, taskId, assetKey, contentType, status: "ready", meta });

/** Pretend to be the worker/bot: produce every output a task is responsible for. */
async function fulfil(task: TaskRow, opts: { skipImages?: string[] } = {}): Promise<Record<string, unknown>> {
  const [p] = await db.select().from(projects).where(eq(projects.id, task.projectId));
  const ep = p.episode as Episode;
  const req = requirements(ep);
  const payload = task.payload as Record<string, unknown>;
  const pick = (ids: string[], key: string) => (Array.isArray(payload[key]) ? (payload[key] as string[]) : ids);
  switch (task.type) {
    case "generate_images":
      for (const item of payload.items as ImageItem[]) {
        if (opts.skipImages?.includes(item.segment_id)) continue;
        await ready(task.projectId, task.id, item.asset_key, "image/png");
      }
      return { uploaded: (payload.items as ImageItem[]).length };
    case "voice": {
      const ids = pick(req.spoken, "segment_ids");
      for (const id of ids) await ready(task.projectId, task.id, assetKeys.voice(id), "audio/flac");
      return { segments: ids.map((id) => ({ segment_id: id, duration_sec: 3 })), usage: [{ provider: "fish", unit: "chars", quantity: 80 }] };
    }
    case "align": {
      await ready(task.projectId, task.id, assetKeys.timeline, "application/json");
      const order = [...ep.segments].sort((a, b) => a.order - b.order);
      return { segments: order.map((s, i) => ({ segment_id: s.id, start_sec: i * 12, end_sec: i * 12 + 12, wer: 0 })) };
    }
    case "sfx": {
      const ids = pick(req.cues.map((c) => c.cue_id), "cue_ids");
      for (const id of ids) {
        await ready(task.projectId, task.id, assetKeys.sfx(id), "audio/flac", {
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
      for (const id of pick(req.cards, "segment_ids")) await ready(task.projectId, task.id, assetKeys.card(id), "image/png");
      return {};
    case "thumbnail_compose":
      for (const v of req.thumbnailVariants) await ready(task.projectId, task.id, assetKeys.thumbnail(v), "image/jpeg");
      return {};
    case "mix":
      await ready(task.projectId, task.id, assetKeys.mixAudio, "audio/wav");
      await ready(task.projectId, task.id, assetKeys.mixReport, "application/json");
      await ready(task.projectId, task.id, assetKeys.captions, "application/x-subrip");
      return { report: { integrated_lufs: -14.1 } };
    case "render":
      await ready(task.projectId, task.id, assetKeys.video, "video/mp4");
      await ready(task.projectId, task.id, assetKeys.preview, "video/mp4");
      return { duration_sec: ep.segments.length * 12 };
    case "upload_youtube":
      return { youtube_url: "https://youtu.be/abc123", video_id: "abc123" };
  }
  return {};
}

/** Drain both queues until nothing is leasable. Returns the types processed in order. */
async function drain(projectId: string, opts: { skipImages?: string[]; maxSteps?: number } = {}): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    const task = (await leaseNext(db, "worker", "test-worker", 60)) ?? (await leaseNext(db, "bot", "test-bot", 60));
    if (!task) break;
    seen.push(task.type);
    const result = await fulfil(task, opts);
    await completeTask(db, task.id, task.leaseId!, result);
    await onTaskCompleted(db, task, result);
    await advance(db, projectId);
  }
  return seen;
}

async function clearQueue() {
  await db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.status, "queued"));
}

describe("pipeline state machine", () => {
  it("runs the minimal fixture end to end to PUBLISHED", async () => {
    await clearQueue();
    const id = await makeProject(minimalText);
    expect((await project(id)).state).toBe("GENERATING");
    const seen = await drain(id);
    expect(seen).toContain("generate_images");
    expect(seen).toContain("render");
    expect(seen.at(-1)).toBe("upload_youtube");
    expect(seen.indexOf("align")).toBeGreaterThan(seen.indexOf("voice"));
    expect(seen.indexOf("mix")).toBeGreaterThan(seen.indexOf("align"));
    const p = await project(id);
    expect(p.state).toBe("PUBLISHED");
    expect(p.youtubeVideoId).toBe("abc123");
    const outputs = p.outputs as { description: string };
    expect(outputs.description).toContain("Sound effects:");
    expect(outputs.description).toContain("CC BY 4.0");
    expect(outputs.description).not.toContain("{{sfx_credits}}");
    const segRows = await db.select().from(segments).where(eq(segments.projectId, id));
    expect(segRows.find((s) => s.segmentId === "seg_002")?.finalPrompt).toContain("Flat 2D cartoon");
  });

  it("does nothing while in DRAFT and starts on demand", async () => {
    await clearQueue();
    const id = await makeProject(minimalText, (raw) => {
      raw.automation = { auto_start_on_submit: false };
    });
    expect((await project(id)).state).toBe("DRAFT");
    expect(await leaseNext(db, "bot", "b", 60)).toBeNull();
  });

  it("stops at the publish gate until approved", async () => {
    await clearQueue();
    const id = await makeProject(minimalText, (raw) => {
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
    const id = await makeProject(fullText, (raw) => {
      (raw.automation as Record<string, unknown>).approval_gates = { before_render: false, before_publish: false };
    });
    await drain(id, { skipImages: ["seg_005"] });
    const p = await project(id);
    expect(p.state).toBe("FAILED");
    expect(p.error).toMatch(/seg_005/);
    const imageTasks = (await db.select().from(tasks).where(eq(tasks.projectId, id))).filter(
      (t) => t.type === "generate_images" && t.scope.startsWith("retry"),
    );
    expect(imageTasks.length).toBeGreaterThan(0);
    for (const t of imageTasks) {
      expect((t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id)).toEqual(["seg_005"]);
    }
    expect((await db.select().from(tasks).where(eq(tasks.projectId, id))).some((t) => t.type === "render")).toBe(false);

    await retryFailed(db, id);
    await drain(id);
    expect((await project(id)).state).toBe("PUBLISHED");
  });

  it("regenerating an image re-renders but does not redo voice", async () => {
    await clearQueue();
    const id = await makeProject(minimalText, (raw) => {
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
    const id = await makeProject(minimalText);
    const task = (await leaseNext(db, "bot", "bot-a", 60))!;
    expect(task.type).toBe("generate_images");
    expect(await heartbeatTask(db, task.id, "wrong-lease", 60)).toBeNull();
    expect(await heartbeatTask(db, task.id, task.leaseId!, 60, { completed_items: 1, total_items: 1 })).not.toBeNull();

    await db.update(tasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(tasks.id, task.id));
    expect(await reapExpired(db)).toContain(id);
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
    const doomed = await makeProject(minimalText);
    const kept = await makeProject(minimalText);
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
