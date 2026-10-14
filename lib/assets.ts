import "server-only";
import { and, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { newId, signToken, verifyToken } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { assets, projects, type AssetRow } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { Owner } from "@/lib/queue";
import { episodeObjectKey, getStorage, projectObjectKey, storyObjectKey } from "@/lib/storage";

export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "application/json": "json",
  "text/plain": "txt",
  "application/x-subrip": "srt",
};

export function kindForKey(assetKey: string): string {
  return assetKey.split("/")[0] ?? "other";
}

export interface NewAsset extends Owner {
  taskId: string | null;
  assetKey: string;
  contentType: string;
  status: "pending" | "ready";
  sizeBytes?: number | null;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
  meta?: Record<string, unknown>;
}

function ownerFilter(o: Owner): SQL {
  if (o.projectId) return eq(assets.projectId, o.projectId);
  if (o.storyId) return eq(assets.storyId, o.storyId);
  throw new Error("Asset owner missing.");
}

export async function createAsset(db: Db, input: NewAsset): Promise<AssetRow> {
  if (!input.projectId === !input.storyId) throw new Error("An asset belongs to exactly one project or story.");
  const id = newId("ast");
  const ext = EXTENSIONS[input.contentType] ?? "bin";
  const name = `${input.assetKey}/${id}.${ext}`;
  let storageKey: string;
  if (input.projectId) {
    const [p] = await db
      .select({ storyId: projects.storyId, episodeNumber: projects.episodeNumber, version: projects.version, episodeId: projects.episodeId })
      .from(projects)
      .where(eq(projects.id, input.projectId));
    storageKey =
      p?.storyId && p.episodeId
        ? episodeObjectKey(p.storyId, p.episodeNumber, p.version, name)
        : projectObjectKey(input.projectId, name);
  } else {
    storageKey = storyObjectKey(input.storyId!, name);
  }
  const [row] = await db
    .insert(assets)
    .values({
      id,
      projectId: input.projectId ?? null,
      storyId: input.storyId ?? null,
      taskId: input.taskId,
      assetKey: input.assetKey,
      kind: kindForKey(input.assetKey),
      storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes ?? null,
      sha256: input.sha256 ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationSec: input.durationSec ?? null,
      status: input.status,
      meta: input.meta ?? {},
    })
    .returning();
  if (input.status === "ready") await supersedeOthers(db, row);
  return row;
}

/**
 * A newly ready asset replaces any earlier ready asset in the same slot. Story masters keep every candidate
 * (the approved one is chosen by id), so they are never superseded here.
 */
export async function supersedeOthers(db: Db, asset: AssetRow): Promise<void> {
  if (!asset.projectId) return;
  await db
    .update(assets)
    .set({ status: "superseded" })
    .where(
      and(
        eq(assets.projectId, asset.projectId),
        eq(assets.assetKey, asset.assetKey),
        eq(assets.status, "ready"),
        ne(assets.id, asset.id),
      ),
    );
}

export async function markAssetReady(db: Db, asset: AssetRow, patch: Partial<AssetRow> = {}): Promise<AssetRow> {
  const [row] = await db
    .update(assets)
    .set({ ...patch, status: "ready" })
    .where(eq(assets.id, asset.id))
    .returning();
  await supersedeOthers(db, row);
  return row;
}

export async function readyAssets(db: Db, projectId: string): Promise<AssetRow[]> {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, projectId), eq(assets.status, "ready")))
    .orderBy(desc(assets.createdAt));
}

export async function readyStoryAssets(db: Db, storyId: string): Promise<AssetRow[]> {
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.storyId, storyId), eq(assets.status, "ready")))
    .orderBy(desc(assets.createdAt));
}

export async function readyAssetMap(db: Db, projectId: string): Promise<Map<string, AssetRow>> {
  const map = new Map<string, AssetRow>();
  for (const asset of await readyAssets(db, projectId)) if (!map.has(asset.assetKey)) map.set(asset.assetKey, asset);
  return map;
}

export async function findReadyBySha(db: Db, owner: Owner, assetKey: string, sha256: string): Promise<AssetRow | null> {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(ownerFilter(owner), eq(assets.assetKey, assetKey), eq(assets.sha256, sha256), eq(assets.status, "ready")))
    .limit(1);
  return row ?? null;
}

export async function pendingAssetsForTask(db: Db, taskId: string, ids: string[]): Promise<AssetRow[]> {
  if (!ids.length) return [];
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.taskId, taskId), inArray(assets.id, ids)));
}

export async function presignAssetGet(asset: AssetRow, baseUrl: string, filename?: string): Promise<string> {
  return getStorage().presignGet(asset.storageKey, {
    baseUrl,
    contentType: asset.contentType,
    downloadFilename: filename,
  });
}

/** Stable link to /api/bot/assets/{id}/download that a browser can open without headers. */
export function signedDownloadLink(baseUrl: string, assetId: string, ttlSec = env.signedUrlTtlSec): string {
  const sig = signToken(env.sessionSecret, `asset:${assetId}`, ttlSec);
  return `${baseUrl}/api/bot/assets/${assetId}/download?sig=${encodeURIComponent(sig)}`;
}

export function verifyDownloadSig(assetId: string, sig: string | null): boolean {
  if (!sig) return false;
  return verifyToken(env.sessionSecret, sig) === `asset:${assetId}`;
}

export interface AssetRef {
  asset_id: string;
  url: string;
  sha256: string | null;
  size_bytes: number | null;
  content_type: string;
  duration_sec: number | null;
  width: number | null;
  height: number | null;
  meta: unknown;
}

export async function assetRef(asset: AssetRow, baseUrl: string): Promise<AssetRef> {
  return {
    asset_id: asset.id,
    url: await presignAssetGet(asset, baseUrl),
    sha256: asset.sha256,
    size_bytes: asset.sizeBytes,
    content_type: asset.contentType,
    duration_sec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    meta: asset.meta,
  };
}
