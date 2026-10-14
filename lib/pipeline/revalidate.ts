import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { episodes, projects } from "@/lib/db/schema";
import { validateText, type ValidationIssue } from "@/lib/episode/validate";
import { logEvent } from "@/lib/queue";
import { loadCastRegistry } from "./cast";
import { recordSnapshot, refreshStoryStateCache } from "./snapshots";
import { loadStoryContext } from "./story";

export interface Revalidation {
  checked_at: string;
  ok: boolean;
  /** The episode whose change triggered the re-check. */
  after_episode: number;
  errors: ValidationIssue[];
}

export interface RevalidationResult {
  projectId: string;
  episodeNumber: number;
  version: number;
  ok: boolean;
  errors: ValidationIssue[];
}

/**
 * An earlier episode was added, replaced or deleted: re-check every later episode's active version in order
 * against the new chain of snapshots and store their new end states. Nothing is deleted; versions that no
 * longer pass keep `needs_revalidation` (shown in the folder) until a fixed version is pasted.
 */
export async function revalidateLaterEpisodes(db: Db, storyId: string, changedEpisode: number): Promise<RevalidationResult[]> {
  const later = await db
    .select({ project: projects, number: episodes.number })
    .from(episodes)
    .innerJoin(projects, eq(projects.id, episodes.activeVersionId))
    .where(and(eq(episodes.storyId, storyId), gt(episodes.number, changedEpisode)))
    .orderBy(asc(episodes.number));
  if (!later.length) return [];
  await db
    .update(projects)
    .set({ needsRevalidation: true })
    .where(inArray(projects.id, later.map((r) => r.project.id)));
  const registry = await loadCastRegistry(db);
  const results: RevalidationResult[] = [];
  for (const { project, number } of later) {
    const ctx = await loadStoryContext(db, storyId);
    if (!ctx) break;
    const result = validateText(project.rawJson, { story: { ...ctx, registry }, registry });
    const end = result.continuity?.end;
    if (end) await recordSnapshot(db, { projectId: project.id, storyId, episodeNumber: number, version: project.version }, end);
    const revalidation: Revalidation = {
      checked_at: new Date().toISOString(),
      ok: result.ok,
      after_episode: changedEpisode,
      errors: result.errors.slice(0, 20),
    };
    await db.update(projects).set({ needsRevalidation: !result.ok, revalidation }).where(eq(projects.id, project.id));
    if (!result.ok) {
      await logEvent(
        db,
        project.id,
        null,
        "warning",
        `Episode ${number} no longer passes continuity after Episode ${changedEpisode} changed: ${result.errors[0]?.message ?? "invalid"}`,
      );
    }
    results.push({ projectId: project.id, episodeNumber: number, version: project.version, ok: result.ok, errors: result.errors });
  }
  await refreshStoryStateCache(db, storyId);
  return results;
}
