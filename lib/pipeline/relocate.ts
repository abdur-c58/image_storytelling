import "server-only";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { assets, projects, type AssetRow } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { episodeObjectKey, getStorage, storyObjectKey } from "@/lib/storage";

export interface RelocatePlan {
  assetId: string;
  from: string;
  to: string;
}

export interface RelocateReport {
  planned: RelocatePlan[];
  moved: number;
  failed: { assetId: string; error: string }[];
}

/**
 * Where an asset stored before schema 2.3 belongs now: projects/{id}/… → stories/{story}/ep{NN}/v{V}/…, and
 * stories/{story}/master/… → stories/{story}/masters/…. Null when it is already in place or can't be filed.
 */
function target(asset: AssetRow, project: { storyId: string | null; episodeNumber: number; version: number; episodeId: string | null } | undefined): string | null {
  const prefix = env.storagePrefix;
  if (asset.projectId) {
    const old = `${prefix}projects/${asset.projectId}/`;
    if (!asset.storageKey.startsWith(old) || !project?.storyId || !project.episodeId) return null;
    return episodeObjectKey(project.storyId, project.episodeNumber, project.version, asset.storageKey.slice(old.length));
  }
  if (asset.storyId) {
    const base = `${prefix}stories/${asset.storyId}/`;
    if (!asset.storageKey.startsWith(base)) return null;
    const to = storyObjectKey(asset.storyId, asset.storageKey.slice(base.length));
    return to === asset.storageKey ? null : to;
  }
  return null;
}

/**
 * Copy pre-2.3 objects to the story folder layout and point their rows at the copies. Without `apply` it only
 * lists what would move. Old objects are kept unless `deleteOld` (each copy is verified by size first), so a
 * rollback is just restoring the old storage_key values.
 */
export async function relocateAssets(db: Db, options: { apply?: boolean; deleteOld?: boolean; limit?: number } = {}): Promise<RelocateReport> {
  const rows = await db.select().from(assets).orderBy(asc(assets.createdAt));
  const projectRows = await db
    .select({ id: projects.id, storyId: projects.storyId, episodeNumber: projects.episodeNumber, version: projects.version, episodeId: projects.episodeId })
    .from(projects);
  const byId = new Map(projectRows.map((p) => [p.id, p]));
  const planned: RelocatePlan[] = [];
  for (const a of rows) {
    const to = target(a, a.projectId ? byId.get(a.projectId) : undefined);
    if (to) planned.push({ assetId: a.id, from: a.storageKey, to });
    if (planned.length >= (options.limit ?? 1000)) break;
  }
  const report: RelocateReport = { planned, moved: 0, failed: [] };
  if (!options.apply) return report;
  const storage = getStorage();
  const types = new Map(rows.map((a) => [a.id, a.contentType]));
  for (const p of planned) {
    try {
      const size = await storage.head(p.from);
      if (size === null) throw new Error("source object is missing");
      const body = await storage.get(p.from);
      await storage.put(p.to, new Uint8Array(body), types.get(p.assetId) ?? "application/octet-stream");
      if ((await storage.head(p.to)) !== size) throw new Error("copy size mismatch");
      await db.update(assets).set({ storageKey: p.to }).where(eq(assets.id, p.assetId));
      if (options.deleteOld) await storage.delete(p.from);
      report.moved++;
    } catch (error) {
      report.failed.push({ assetId: p.assetId, error: (error as Error).message });
    }
  }
  return report;
}
