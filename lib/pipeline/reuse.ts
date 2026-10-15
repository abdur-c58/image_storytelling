import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { createAsset, markAssetReady, readyAssetMap } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { assets, projects, segments } from "@/lib/db/schema";
import type { Episode } from "@/lib/episode/schema";
import { logEvent } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { assetKeys, requirements } from "./requirements";

export interface ReusedImages {
  /** segment id → version the image was copied from */
  reused: Record<string, number>;
  /** Segments that still need a new image. */
  fresh: string[];
}

type PromptRow = { segmentId: string; finalPrompt: string | null; negativePrompt: string | null };

/** Segments whose picture is unchanged: same segment id, same final prompt and same negative prompt. */
export function unchangedSegments(next: PromptRow[], prev: PromptRow[]): string[] {
  const before = new Map(prev.map((r) => [r.segmentId, r]));
  return next
    .filter((r) => {
      const p = before.get(r.segmentId);
      return !!r.finalPrompt && !!p && p.finalPrompt === r.finalPrompt && (p.negativePrompt ?? "") === (r.negativePrompt ?? "");
    })
    .map((r) => r.segmentId);
}

const COPY_BATCH = 6;

/**
 * A new version of an episode starts with the images of earlier versions wherever the segment id and its final
 * prompt are unchanged (newest version first), so only changed segments go to the image bot. Each reused image
 * is copied into the new version's folder, so deleting an old version never takes a picture away from a new one.
 */
export async function reuseUnchangedImages(db: Db, projectId: string): Promise<ReusedImages> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const wanted = new Set(requirements(project.episode as Episode).images);
  const mine = (await db.select().from(segments).where(eq(segments.projectId, projectId))).filter((r) => wanted.has(r.segmentId));
  const out: ReusedImages = { reused: {}, fresh: [] };
  if (!project.episodeId || !mine.length) return { ...out, fresh: mine.map((r) => r.segmentId) };

  const ready = await readyAssetMap(db, projectId);
  const open = new Map(mine.filter((r) => !ready.has(assetKeys.image(r.segmentId))).map((r) => [r.segmentId, r]));
  const older = await db
    .select({ id: projects.id, version: projects.version })
    .from(projects)
    .where(and(eq(projects.episodeId, project.episodeId), ne(projects.id, projectId)))
    .orderBy(desc(projects.version));
  const storage = getStorage();
  const failed: string[] = [];

  for (const source of older) {
    if (!open.size) break;
    const theirs = await db.select().from(segments).where(eq(segments.projectId, source.id));
    const theirReady = await readyAssetMap(db, source.id);
    const matches = unchangedSegments([...open.values()], theirs).filter((id) => theirReady.has(assetKeys.image(id)) && !failed.some((f) => f.startsWith(`${id} `)));
    for (let i = 0; i < matches.length; i += COPY_BATCH) {
      await Promise.all(
        matches.slice(i, i + COPY_BATCH).map(async (segmentId) => {
          const src = theirReady.get(assetKeys.image(segmentId))!;
          const row = await createAsset(db, {
            projectId,
            taskId: null,
            assetKey: src.assetKey,
            contentType: src.contentType,
            status: "pending",
            sha256: src.sha256,
            width: src.width,
            height: src.height,
            meta: { ...(src.meta as object), reused_from: { project_id: source.id, version: source.version, asset_id: src.id } },
          });
          try {
            await storage.copy(src.storageKey, row.storageKey);
            const size = await storage.head(row.storageKey);
            if (size === null) throw new Error("the copy is missing");
            await markAssetReady(db, row, { sizeBytes: size });
            out.reused[segmentId] = source.version;
            open.delete(segmentId);
          } catch (error) {
            await db.delete(assets).where(eq(assets.id, row.id));
            failed.push(`${segmentId} (${(error as Error).message})`);
          }
        }),
      );
    }
  }
  out.fresh = [...open.keys()];
  if (failed.length) {
    await logEvent(db, projectId, null, "warning", `Could not copy ${failed.length} earlier image(s); they are generated again: ${failed.slice(0, 6).join("; ")}.`);
  }

  const reusedIds = Object.keys(out.reused);
  if (reusedIds.length) {
    const versions = [...new Set(Object.values(out.reused))].sort((a, b) => b - a).map((v) => `v${v}`).join(", ");
    await logEvent(
      db,
      projectId,
      null,
      "info",
      `Reused ${reusedIds.length} unchanged image(s) from ${versions}; ${out.fresh.length} segment(s) need a new image${out.fresh.length ? ` (${out.fresh.slice(0, 12).join(", ")}${out.fresh.length > 12 ? ", …" : ""})` : ""}.`,
      { reused: out.reused },
    );
  }
  return out;
}
