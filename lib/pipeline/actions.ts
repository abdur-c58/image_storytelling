import "server-only";
import { and, eq, inArray, like, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { assets, projects, segments, sfxCues, tasks } from "@/lib/db/schema";
import { buildSegmentImageItem, segmentNeedsGeneratedImage } from "@/lib/episode/prompt";
import type { Episode } from "@/lib/episode/schema";
import { createTask, logEvent, retryTask } from "@/lib/queue";
import { episodeObjectPrefix, getStorage, projectObjectPrefix } from "@/lib/storage";
import { advance, imageTaskPayload, invalidateDownstreamOf, invalidateStages } from "./advance";
import { assetKeys, requirements } from "./requirements";

async function loadProject(db: Db, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found.");
  return { project, ep: project.episode as Episode };
}

export async function startProject(db: Db, projectId: string): Promise<void> {
  await db.update(projects).set({ state: "VALIDATED", stateDetail: "Starting…" }).where(and(eq(projects.id, projectId), eq(projects.state, "DRAFT")));
  await advance(db, projectId);
}

/** Retry every dead task (or one) with a fresh attempt budget and clear the project error. */
export async function retryFailed(db: Db, projectId: string, taskId?: string): Promise<void> {
  const dead = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, ["dead"]), ...(taskId ? [eq(tasks.id, taskId)] : [])));
  for (const t of dead) {
    // advance() re-requests whatever images are still missing, so an old batch must not redo fixed ones.
    if (t.type === "generate_images") await retireDeadImageTasks(db, projectId, t.id);
    else await retryTask(db, t.id);
  }
  await db
    .update(tasks)
    .set({ status: "superseded" })
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, "done"), ne(tasks.type, "upload_youtube")));
  await db.update(segments).set({ imageAttempts: 0 }).where(eq(segments.projectId, projectId));
  await db.update(projects).set({ error: null }).where(eq(projects.id, projectId));
  await logEvent(db, projectId, null, "info", `Retry requested for ${dead.length} failed task(s).`);
  await advance(db, projectId);
}

async function retireDeadImageTasks(db: Db, projectId: string, taskId?: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(eq(tasks.projectId, projectId), eq(tasks.type, "generate_images"), eq(tasks.status, "dead"), ...(taskId ? [eq(tasks.id, taskId)] : [])),
    );
}

export async function regenerateImage(db: Db, projectId: string, segmentId: string): Promise<void> {
  const { ep } = await loadProject(db, projectId);
  const segment = ep.segments.find((s) => s.id === segmentId);
  if (!segment || !segmentNeedsGeneratedImage(segment)) throw new Error(`${segmentId} has no generated image.`);
  const item = buildSegmentImageItem(ep, segment);
  await createTask(db, {
    projectId,
    kind: "bot",
    type: "generate_images",
    scope: `regen:${segmentId}:${Date.now()}`,
    payload: imageTaskPayload(projectId, ep, [item], "segments"),
    priority: 20,
    maxAttempts: 3,
    timeoutMinutes: 60,
  });
  await retireDeadImageTasks(db, projectId);
  await db.update(segments).set({ imageAttempts: 0 }).where(and(eq(segments.projectId, projectId), eq(segments.segmentId, segmentId)));
  const affectedCards = Object.entries(requirements(ep).cardBackgrounds)
    .filter(([, src]) => src === segmentId)
    .map(([card]) => card);
  if (affectedCards.length) {
    await db
      .update(assets)
      .set({ status: "superseded" })
      .where(and(eq(assets.projectId, projectId), inArray(assets.assetKey, affectedCards.map(assetKeys.card)), eq(assets.status, "ready")));
  }
  await invalidateDownstreamOf(db, projectId, "generate_images", `image for ${segmentId} is being regenerated`);
  await advance(db, projectId);
}

export async function regenerateThumbnailBase(db: Db, projectId: string): Promise<void> {
  await db
    .update(assets)
    .set({ status: "superseded" })
    .where(and(eq(assets.projectId, projectId), eq(assets.kind, "thumbnail_base"), eq(assets.status, "ready")));
  await db
    .update(tasks)
    .set({ status: "superseded" })
    .where(
      and(eq(tasks.projectId, projectId), eq(tasks.type, "generate_images"), eq(tasks.status, "done"), like(tasks.scope, "thumbnail%")),
    );
  await invalidateDownstreamOf(db, projectId, "thumbnail_base", "thumbnail base is being regenerated");
  await advance(db, projectId);
}

export async function regenerateVoice(db: Db, projectId: string, segmentId: string): Promise<void> {
  const { ep } = await loadProject(db, projectId);
  if (!requirements(ep).spoken.includes(segmentId)) throw new Error(`${segmentId} has no narration.`);
  await createTask(db, {
    projectId,
    kind: "worker",
    type: "voice",
    scope: `redo:${segmentId}:${Date.now()}`,
    payload: { segment_ids: [segmentId], force: true },
    priority: 12,
  });
  await invalidateDownstreamOf(db, projectId, "voice", `voice for ${segmentId} is being regenerated`);
  await advance(db, projectId);
}

export async function swapSfx(db: Db, projectId: string, cueId: string, candidateIndex: number): Promise<void> {
  const [cue] = await db.select().from(sfxCues).where(and(eq(sfxCues.projectId, projectId), eq(sfxCues.cueId, cueId)));
  if (!cue) throw new Error(`Unknown SFX cue ${cueId}.`);
  const candidates = cue.candidates as unknown[];
  if (candidateIndex < 0 || candidateIndex >= candidates.length) throw new Error("Candidate index out of range.");
  await db
    .update(sfxCues)
    .set({ selectedIndex: candidateIndex, updatedAt: new Date() })
    .where(and(eq(sfxCues.projectId, projectId), eq(sfxCues.cueId, cueId)));
  await createTask(db, {
    projectId,
    kind: "worker",
    type: "sfx",
    scope: `swap:${cueId}:${Date.now()}`,
    payload: { cue_ids: [cueId], use_selection: true },
    priority: 12,
  });
  await invalidateDownstreamOf(db, projectId, "sfx", `SFX ${cueId} swapped to candidate ${candidateIndex + 1}`);
  await advance(db, projectId);
}

export async function rerender(db: Db, projectId: string): Promise<void> {
  await invalidateStages(db, projectId, ["mix", "render", "upload_youtube"], "re-render requested");
  await advance(db, projectId);
}

export async function approveGate(db: Db, projectId: string, gate: "render" | "publish"): Promise<void> {
  await db
    .update(projects)
    .set(gate === "render" ? { approvedRenderAt: new Date() } : { approvedPublishAt: new Date() })
    .where(eq(projects.id, projectId));
  await logEvent(db, projectId, null, "info", `Approved ${gate}.`);
  await advance(db, projectId);
}

export async function archiveProject(db: Db, projectId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "cancelled" })
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, ["queued", "leased"])));
  await db.update(projects).set({ archived: true }).where(eq(projects.id, projectId));
}

/**
 * Permanently removes a project: its stored files first, then the row (segments, assets, tasks,
 * events and SFX cues cascade). If storage fails the project stays intact so the delete can be retried.
 */
export async function deleteProject(db: Db, projectId: string): Promise<{ filesDeleted: number }> {
  const { project } = await loadProject(db, projectId);
  await db
    .update(tasks)
    .set({ status: "cancelled" })
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.status, ["queued", "leased"])));
  const storage = getStorage();
  const prefixes = [projectObjectPrefix(projectId)];
  if (project.storyId && project.episodeId) prefixes.push(episodeObjectPrefix(project.storyId, project.episodeNumber, project.version));
  let filesDeleted = 0;
  for (const prefix of prefixes) filesDeleted += await storage.deletePrefix(prefix);
  const stray = await db.select({ key: assets.storageKey }).from(assets).where(eq(assets.projectId, projectId));
  for (const { key } of stray) {
    if (key && !prefixes.some((p) => key.startsWith(p))) {
      await storage.delete(key);
      filesDeleted++;
    }
  }
  await db.delete(projects).where(eq(projects.id, projectId));
  return { filesDeleted };
}
