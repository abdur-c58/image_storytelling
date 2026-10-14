import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { createAsset, markAssetReady, readyAssetMap } from "@/lib/assets";
import { newId, sha256Hex } from "@/lib/crypto";
import { applyCropPlans, type LineTiming, type SegmentCropSetting, type Timeline } from "@/lib/crop/timeline";
import type { Db } from "@/lib/db";
import { projects, segments } from "@/lib/db/schema";
import { isResolvedV2 } from "@/lib/episode/resolve";
import { logEvent } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { advance, invalidateStages } from "./advance";
import { assetKeys } from "./requirements";

export interface CropSummary {
  planned_at: string;
  segments: Record<string, { sentences: unknown[]; crop_plan: unknown[]; crop_seed: string | null; enabled: boolean | null; salt: number }>;
}

/**
 * Write sentences + crop_plan into the aligned timeline.json (a new timeline version) and keep a summary on the
 * project for the UI. v1 projects have no crop policy and are left alone. Returns whether a plan was written.
 */
export async function planCrops(db: Db, projectId: string): Promise<boolean> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || !isResolvedV2(project.episode)) return false;
  const ready = await readyAssetMap(db, projectId);
  const current = ready.get(assetKeys.timeline);
  if (!current) return false;
  const storage = getStorage();
  const timeline = JSON.parse((await storage.get(current.storageKey)).toString("utf8")) as Timeline;
  const segRows = await db.select().from(segments).where(eq(segments.projectId, projectId));
  const settings: Record<string, SegmentCropSetting> = Object.fromEntries(
    segRows.map((r) => [r.segmentId, { enabled: r.cropEnabled, salt: r.cropSalt }]),
  );
  const lineTimings: Record<string, LineTiming[]> = Object.fromEntries(
    segRows.filter((r) => (r.lineTimings as LineTiming[]).length).map((r) => [r.segmentId, r.lineTimings as LineTiming[]]),
  );
  const next = applyCropPlans(timeline, project.episode, { projectSeed: project.cropSeed || project.id, settings, lineTimings });
  const bytes = new TextEncoder().encode(JSON.stringify(next));
  const asset = await createAsset(db, {
    projectId,
    taskId: null,
    assetKey: assetKeys.timeline,
    contentType: "application/json",
    status: "pending",
    sizeBytes: bytes.length,
    sha256: sha256Hex(bytes),
    meta: { crop_planned: true, source_asset_id: current.id },
  });
  await storage.put(asset.storageKey, bytes, "application/json");
  await markAssetReady(db, asset);

  const summary: CropSummary = {
    planned_at: new Date().toISOString(),
    segments: Object.fromEntries(
      next.segments.map((s) => [
        s.id,
        {
          sentences: s.sentences ?? [],
          crop_plan: s.crop_plan ?? [],
          crop_seed: s.crop_seed ?? null,
          enabled: settings[s.id]?.enabled ?? null,
          salt: settings[s.id]?.salt ?? 0,
        },
      ]),
    ),
  };
  const [fresh] = await db.select().from(projects).where(eq(projects.id, projectId));
  await db
    .update(projects)
    .set({ outputs: { ...(fresh.outputs as object), crop: summary } })
    .where(eq(projects.id, projectId));
  const crops = next.segments.reduce((n, s) => n + (s.crop_plan ?? []).filter((k) => k.kind === "crop").length, 0);
  await logEvent(db, projectId, null, "info", `Crop plan written: ${crops} crop(s) across ${next.segments.length} segments.`);
  return true;
}

async function replan(db: Db, projectId: string, reason: string) {
  const planned = await planCrops(db, projectId);
  if (!planned) {
    await logEvent(db, projectId, null, "info", `${reason}; the crop plan is made after alignment.`);
    return;
  }
  await invalidateStages(db, projectId, ["render", "upload_youtube"], reason);
  await advance(db, projectId);
}

/** New random crops for one segment (salt) or the whole episode (seed). Only the render re-runs. */
export async function rerollCrops(db: Db, projectId: string, segmentId?: string): Promise<void> {
  if (segmentId) {
    await db
      .update(segments)
      .set({ cropSalt: sql`${segments.cropSalt} + 1`, updatedAt: new Date() })
      .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, segmentId)));
  } else {
    await db.update(projects).set({ cropSeed: newId("crop") }).where(eq(projects.id, projectId));
  }
  await replan(db, projectId, segmentId ? `crops re-rolled for ${segmentId}` : "crops re-rolled for the whole episode");
}

/** Per-segment crop toggle: true/false overrides the policy, null follows it. */
export async function setSegmentCrop(db: Db, projectId: string, segmentId: string, enabled: boolean | null): Promise<void> {
  await db
    .update(segments)
    .set({ cropEnabled: enabled, updatedAt: new Date() })
    .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, segmentId)));
  const what = enabled === null ? "follow the policy" : enabled ? "on" : "off";
  await replan(db, projectId, `crops for ${segmentId} set to ${what}`);
}
