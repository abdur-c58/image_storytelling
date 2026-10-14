import "server-only";
import { and, eq, inArray, ne, notLike } from "drizzle-orm";
import { z } from "zod";
import { createAsset, findReadyBySha, markAssetReady } from "@/lib/assets";
import { sha256Hex } from "@/lib/crypto";
import { getDb, type Db } from "@/lib/db";
import { assets, projects, stories, tasks, type AssetRow, type TaskRow } from "@/lib/db/schema";
import type { ImageItem } from "@/lib/episode/prompt";
import type { Episode, StoryBible } from "@/lib/episode/schema";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { checkGeneratedImage, contentTypeForFormat } from "@/lib/images";
import { advance } from "@/lib/pipeline/advance";
import { finalizeWorkerAssets, onTaskCompleted } from "@/lib/pipeline/complete";
import { hydrateTask } from "@/lib/pipeline/payloads";
import { advanceStory, MASTER_PRIORITY } from "@/lib/pipeline/story";
import {
  BOT_TASK_TYPES,
  completeTask,
  failTask,
  getLeasedTask,
  heartbeatTask,
  leaseNext,
  logEvent,
  ownerOf,
  reapExpired,
  touchAgent,
  WORKER_TASK_TYPES,
  type Owner,
  type Progress,
  type TaskKind,
} from "@/lib/queue";
import { getStorage } from "@/lib/storage";

const MB = 1024 * 1024;

/** What each task type may write, and the content types and sizes allowed per slot. */
const SLOT_RULES: { prefix: string; types: string[]; maxBytes: number }[] = [
  { prefix: "image/", types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 25 * MB },
  { prefix: "thumbnail_base/", types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 25 * MB },
  { prefix: "master/", types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 25 * MB },
  { prefix: "card/", types: ["image/png"], maxBytes: 25 * MB },
  { prefix: "thumbnail/", types: ["image/jpeg"], maxBytes: 2 * MB },
  { prefix: "voice/", types: ["audio/flac", "audio/wav", "audio/x-wav"], maxBytes: 200 * MB },
  { prefix: "voice_sample/", types: ["audio/flac", "audio/wav", "audio/x-wav"], maxBytes: 20 * MB },
  { prefix: "sfx/", types: ["audio/flac", "audio/wav", "audio/x-wav"], maxBytes: 100 * MB },
  { prefix: "timeline/", types: ["application/json"], maxBytes: 10 * MB },
  { prefix: "mix/report", types: ["application/json"], maxBytes: 10 * MB },
  { prefix: "mix/audio", types: ["audio/wav", "audio/x-wav", "audio/flac"], maxBytes: 2048 * MB },
  { prefix: "captions/", types: ["application/x-subrip", "text/plain"], maxBytes: 5 * MB },
  { prefix: "video/", types: ["video/mp4"], maxBytes: 8192 * MB },
];

const TYPE_PREFIXES: Record<string, string[]> = {
  voice: ["voice/"],
  voice_sample: ["voice_sample/"],
  align: ["timeline/"],
  sfx: ["sfx/"],
  cards: ["card/"],
  thumbnail_compose: ["thumbnail/"],
  mix: ["mix/", "captions/"],
  render: ["video/"],
};

function slotRule(assetKey: string) {
  return SLOT_RULES.find((r) => assetKey.startsWith(r.prefix)) ?? null;
}

const BOT_IMAGE_TASKS = new Set(["generate_images", "generate_location_master", "generate_character_group_master"]);

export function allowedKey(task: TaskRow, assetKey: string): boolean {
  if (BOT_IMAGE_TASKS.has(task.type)) {
    return ((task.payload as { items?: ImageItem[] }).items ?? []).some((i) => i.asset_key === assetKey);
  }
  return (TYPE_PREFIXES[task.type] ?? []).some((p) => assetKey.startsWith(p));
}

function checkSlot(task: TaskRow, assetKey: string, contentType: string, sizeBytes: number | undefined) {
  if (!allowedKey(task, assetKey)) throw new HttpError(403, `Task ${task.type} (${task.scope}) may not write "${assetKey}".`);
  const rule = slotRule(assetKey);
  if (!rule) throw new HttpError(400, `Unknown asset slot "${assetKey}".`);
  if (!rule.types.includes(contentType)) {
    throw new HttpError(415, `"${assetKey}" must be one of: ${rule.types.join(", ")} (got ${contentType}).`);
  }
  if (sizeBytes !== undefined && sizeBytes > rule.maxBytes) {
    throw new HttpError(413, `"${assetKey}" is ${sizeBytes} bytes; the limit is ${rule.maxBytes}.`);
  }
  return rule;
}

async function requireLease(db: Db, kind: TaskKind, taskId: string, leaseId: string): Promise<TaskRow> {
  const task = await getLeasedTask(db, taskId, leaseId);
  if (!task || task.kind !== kind) {
    throw new HttpError(409, "This lease is no longer valid (expired, completed, or taken by another client). Stop work on this task.", {
      code: "lease_lost",
    });
  }
  return task;
}

export async function advanceOwner(db: Db, owner: Owner) {
  if (owner.projectId) await advance(db, owner.projectId);
  else if (owner.storyId) await advanceStory(db, owner.storyId);
}

async function sweep(db: Db) {
  for (const owner of await reapExpired(db)) await advanceOwner(db, owner);
  // Master batches queued at another priority predate on-demand masters; re-plan their stories before leasing.
  const legacy = await db
    .selectDistinct({ storyId: tasks.storyId })
    .from(tasks)
    .where(
      and(
        inArray(tasks.type, ["generate_location_master", "generate_character_group_master"]),
        eq(tasks.status, "queued"),
        ne(tasks.priority, MASTER_PRIORITY),
        notLike(tasks.scope, "regen:%"),
      ),
    );
  for (const { storyId } of legacy) if (storyId) await advanceStory(db, storyId);
}

/** Width below which an accepted image is flagged for upscaling (the worker upscales before render). */
async function preferredMinWidth(db: Db, task: TaskRow): Promise<number> {
  if (task.projectId) {
    const [p] = await db.select({ episode: projects.episode }).from(projects).where(eq(projects.id, task.projectId));
    return (p?.episode as Episode | undefined)?.style_bible?.source_image_min_width ?? 2560;
  }
  if (task.storyId) {
    const [s] = await db.select({ bible: stories.bible }).from(stories).where(eq(stories.id, task.storyId));
    return (s?.bible as StoryBible | undefined)?.style_bible.source_image_min_width ?? 2560;
  }
  return 2560;
}

export async function claimNext(kind: TaskKind, agentId: string, base: string, types?: string[], info?: Record<string, unknown>) {
  const db = await getDb();
  await touchAgent(db, agentId, kind, info);
  await sweep(db);
  const allowed = (kind === "bot" ? BOT_TASK_TYPES : WORKER_TASK_TYPES) as readonly string[];
  const filter = types?.length ? types.filter((t) => allowed.includes(t)) : [...allowed];
  if (!filter.length) return null;
  const task = await leaseNext(db, kind, agentId, kind === "bot" ? env.botLeaseSec : env.workerLeaseSec, filter);
  if (!task) return null;
  let projectTitle = "";
  if (task.projectId) {
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId));
    projectTitle = project?.title ?? "";
  }
  await advanceOwner(db, ownerOf(task));
  const hydrated = await hydrateTask(db, task, base);
  return {
    ...hydrated,
    lease_seconds: kind === "bot" ? env.botLeaseSec : env.workerLeaseSec,
    heartbeat_every_seconds: Math.floor((kind === "bot" ? env.botLeaseSec : env.workerLeaseSec) / 3),
    project_title: projectTitle,
    story_title: hydrated.story_title ?? "",
    dry_run: env.dryRun,
  };
}

export async function heartbeat(kind: TaskKind, agentId: string, taskId: string, leaseId: string, progress?: Progress) {
  const db = await getDb();
  await touchAgent(db, agentId, kind);
  await requireLease(db, kind, taskId, leaseId);
  const row = await heartbeatTask(db, taskId, leaseId, kind === "bot" ? env.botLeaseSec : env.workerLeaseSec, progress);
  return { ok: true, lease_expires_at: row?.leaseExpiresAt };
}

export const RegisterUploadSchema = z.object({
  lease_id: z.string().min(1),
  asset_key: z.string().min(1).max(200),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_sec: z.number().nonnegative().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Reserve a slot and hand back a presigned PUT URL. If the same bytes (by sha256) are already
 * ready in that slot, nothing needs uploading.
 */
export async function registerUpload(kind: TaskKind, taskId: string, input: z.infer<typeof RegisterUploadSchema>, base: string) {
  const db = await getDb();
  const task = await requireLease(db, kind, taskId, input.lease_id);
  checkSlot(task, input.asset_key, input.content_type, input.size_bytes);
  if (input.sha256) {
    const existing = await findReadyBySha(db, ownerOf(task), input.asset_key, input.sha256);
    if (existing) return { asset_id: existing.id, already_present: true, upload_url: null };
  }
  const asset = await createAsset(db, {
    ...ownerOf(task),
    taskId: task.id,
    assetKey: input.asset_key,
    contentType: input.content_type,
    status: "pending",
    sizeBytes: input.size_bytes ?? null,
    sha256: input.sha256 ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationSec: input.duration_sec ?? null,
    meta: input.meta ?? {},
  });
  const uploadUrl = await getStorage().presignPut(asset.storageKey, {
    baseUrl: base,
    contentType: input.content_type,
    ttlSec: 3600,
  });
  return {
    asset_id: asset.id,
    already_present: false,
    upload_url: uploadUrl,
    upload_method: "PUT",
    upload_headers: { "content-type": input.content_type },
  };
}

/** QA an uploaded bot image and mark it ready, or reject it with a reason the bot can act on. */
async function verifyBotImage(db: Db, asset: AssetRow, task: TaskRow): Promise<{ ok: boolean; reason: string | null; asset: AssetRow }> {
  const storage = getStorage();
  const size = await storage.head(asset.storageKey);
  if (size === null) return { ok: false, reason: "File was never uploaded to the upload URL.", asset };
  const rule = slotRule(asset.assetKey);
  if (rule && size > rule.maxBytes) return { ok: false, reason: `File is too large (${size} bytes).`, asset };
  const bytes = await storage.get(asset.storageKey);
  const check = await checkGeneratedImage(bytes);
  if (!check.ok) {
    await db.update(assets).set({ status: "rejected", meta: { ...(asset.meta as object), rejected: check.reason } }).where(eq(assets.id, asset.id));
    return { ok: false, reason: check.reason, asset };
  }
  const meta = await lowResMeta(db, task, asset, check.width ?? 0);
  const ready = await markAssetReady(db, asset, {
    sizeBytes: size,
    sha256: sha256Hex(bytes),
    width: check.width,
    height: check.height,
    contentType: contentTypeForFormat(check.format),
    meta,
  });
  return { ok: true, reason: null, asset: ready };
}

async function lowResMeta(db: Db, task: TaskRow, asset: Pick<AssetRow, "assetKey" | "meta">, width: number) {
  const min = await preferredMinWidth(db, task);
  const meta = { ...((asset.meta as object) ?? {}) } as Record<string, unknown>;
  if (width < min) {
    meta.upscale_needed = true;
    meta.preferred_min_width = min;
    await logEvent(
      db,
      ownerOf(task),
      task.id,
      "warning",
      `${asset.assetKey}: ${width}px wide, under the preferred ${min}px; it will be upscaled before rendering (crops look softer).`,
    );
  }
  return meta;
}

export async function confirmBotUpload(taskId: string, leaseId: string, assetId: string) {
  const db = await getDb();
  const task = await requireLease(db, "bot", taskId, leaseId);
  const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.taskId, task.id)));
  if (!asset) throw new HttpError(404, "Unknown asset for this task.");
  if (asset.status === "ready") return { asset_id: asset.id, accepted: true, reason: null };
  const result = await verifyBotImage(db, asset, task);
  return { asset_id: asset.id, accepted: result.ok, reason: result.reason, width: result.asset.width, height: result.asset.height };
}

/** Small-file path for browser uploads and simple bots: multipart straight to this server. */
export async function directBotUpload(taskId: string, leaseId: string, assetKey: string, file: File) {
  const db = await getDb();
  const task = await requireLease(db, "bot", taskId, leaseId);
  const contentType = file.type || "image/png";
  checkSlot(task, assetKey, contentType, file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = await checkGeneratedImage(bytes);
  if (!check.ok) return { asset_id: null, accepted: false, reason: check.reason };
  const sha = sha256Hex(bytes);
  const existing = await findReadyBySha(db, ownerOf(task), assetKey, sha);
  if (existing) return { asset_id: existing.id, accepted: true, reason: null };
  const finalType = contentTypeForFormat(check.format);
  const asset = await createAsset(db, {
    ...ownerOf(task),
    taskId: task.id,
    assetKey,
    contentType: finalType,
    status: "pending",
    sizeBytes: bytes.length,
    sha256: sha,
    width: check.width,
    height: check.height,
  });
  await getStorage().put(asset.storageKey, bytes, finalType);
  await markAssetReady(db, asset, { meta: await lowResMeta(db, task, asset, check.width ?? 0) });
  return { asset_id: asset.id, accepted: true, reason: null, width: check.width, height: check.height };
}

export async function itemStatus(task: TaskRow) {
  const db = await getDb();
  const items = (task.payload as { items?: ImageItem[] }).items ?? [];
  const rows = await db.select().from(assets).where(and(eq(assets.taskId, task.id), eq(assets.status, "ready")));
  const done = new Set(rows.map((r) => r.assetKey));
  return items.map((i) => ({ asset_key: i.asset_key, segment_id: i.segment_id, uploaded: done.has(i.asset_key) }));
}

const YOUTUBE_URL = /^https:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/|studio\.youtube\.com\/video\/)[\w-]{6,}/;

export const CompleteSchema = z.object({
  lease_id: z.string().min(1),
  result: z.record(z.string(), z.unknown()).default({}),
  asset_ids: z.array(z.string()).default([]),
});

export async function complete(kind: TaskKind, agentId: string, taskId: string, body: z.infer<typeof CompleteSchema>) {
  const db = await getDb();
  await touchAgent(db, agentId, kind);
  const task = await requireLease(db, kind, taskId, body.lease_id);
  const result = { ...body.result };

  if (BOT_IMAGE_TASKS.has(task.type)) {
    const pending = await db.select().from(assets).where(and(eq(assets.taskId, task.id), eq(assets.status, "pending")));
    for (const asset of pending) await verifyBotImage(db, asset, task);
    const status = await itemStatus(task);
    result.items = status;
    result.missing = status.filter((s) => !s.uploaded).map((s) => s.segment_id);
  } else if (task.type === "upload_youtube") {
    const url = String(result.youtube_url ?? "");
    if (!YOUTUBE_URL.test(url)) {
      throw new HttpError(400, "result.youtube_url must be the YouTube video URL (https://youtu.be/<id> or https://www.youtube.com/watch?v=<id>).");
    }
    const id = /(?:v=|youtu\.be\/|shorts\/|video\/)([\w-]{6,})/.exec(url)?.[1];
    result.video_id ??= id;
  } else {
    const error = await finalizeWorkerAssets(db, task, body.asset_ids);
    if (error) {
      await failTask(db, task.id, body.lease_id, error, true);
      await advanceOwner(db, ownerOf(task));
      throw new HttpError(422, error);
    }
  }

  const done = await completeTask(db, task.id, body.lease_id, result);
  if (!done) throw new HttpError(409, "Lease lost while completing.", { code: "lease_lost" });
  await onTaskCompleted(db, task, result);
  await advanceOwner(db, ownerOf(task));
  return { ok: true, ...(BOT_IMAGE_TASKS.has(task.type) ? { missing: result.missing } : {}) };
}

export const FailSchema = z.object({
  lease_id: z.string().min(1),
  reason: z.string().min(1).max(4000),
  retryable: z.boolean().default(true),
});

export async function fail(kind: TaskKind, agentId: string, taskId: string, body: z.infer<typeof FailSchema>) {
  const db = await getDb();
  await touchAgent(db, agentId, kind);
  const task = await requireLease(db, kind, taskId, body.lease_id);
  const row = await failTask(db, task.id, body.lease_id, body.reason, body.retryable);
  await advanceOwner(db, ownerOf(task));
  return { ok: true, status: row?.status, available_at: row?.availableAt };
}
