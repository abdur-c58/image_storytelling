import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { newId } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { episodes, projects, segments } from "@/lib/db/schema";
import { buildImageItems } from "@/lib/episode/prompt";
import type { ValidationResult } from "@/lib/episode/validate";
import { logEvent } from "@/lib/queue";
import { archiveProject } from "./actions";
import { advance } from "./advance";
import { orderedSegments } from "./requirements";
import { revalidateLaterEpisodes } from "./revalidate";
import { recordSnapshot, refreshStoryStateCache } from "./snapshots";

export interface CreatedVersion {
  projectId: string;
  episodeId: string;
  version: number;
  /** The version this one replaced as the active one. */
  replaced: string | null;
}

/**
 * Store a validated episode as a new version of its episode in the story folder (creating the episode on its
 * first paste) and make it the active version. The previous active version is stopped, never overwritten.
 * Its end state becomes the snapshot later episodes are validated against, and later episodes are re-checked.
 */
export async function createVersion(db: Db, rawJson: string, validation: ValidationResult): Promise<CreatedVersion> {
  const ep = validation.episode;
  if (!validation.ok || !ep) throw new Error("Cannot create a project from an invalid episode.");
  const storyId = ep.story.story_id;
  const number = ep.series.episode_number;
  const episodeTitle = ep.episode_title ?? ep.series.episode_title_short;
  const id = newId("prj");
  const autoStart = ep.automation.auto_start_on_submit;

  const created = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .insert(episodes)
      .values({ id: newId("epi"), storyId, number, title: episodeTitle })
      .onConflictDoNothing({ target: [episodes.storyId, episodes.number] });
    const [episode] = await tx
      .update(episodes)
      .set({ versionCounter: sql`${episodes.versionCounter} + 1`, title: episodeTitle, updatedAt: new Date() })
      .where(and(eq(episodes.storyId, storyId), eq(episodes.number, number)))
      .returning();
    const version = episode.versionCounter;
    await tx.insert(projects).values({
      id,
      storyId,
      episodeId: episode.id,
      version,
      cropSeed: newId("crop"),
      seriesId: ep.series.series_id,
      episodeNumber: number,
      title: ep.youtube.title,
      state: autoStart ? "VALIDATED" : "DRAFT",
      stateDetail: autoStart ? "Starting…" : "Not started. Press Start to run the pipeline.",
      episode: ep,
      rawJson,
      estimate: validation.estimate ?? {},
      warnings: validation.warnings,
      outputs: validation.continuity ? { story_state_end: validation.continuity.end } : {},
    });
    const items = new Map(buildImageItems(ep).map((i) => [i.segment_id, i]));
    const rows = orderedSegments(ep).map((seg) => {
      const item = items.get(seg.id) ?? null;
      return {
        projectId: id,
        segmentId: seg.id,
        order: seg.order,
        type: seg.type,
        narration: seg.silent ? "" : seg.narration,
        finalPrompt: item?.final_prompt ?? null,
        negativePrompt: item?.negative_prompt ?? null,
        promptParts: item?.prompt_parts ?? [],
        masterKeys: item?.master_keys ?? [],
      };
    });
    if (rows.length) await tx.insert(segments).values(rows);
    if (validation.continuity) {
      await recordSnapshot(tx, { projectId: id, storyId, episodeNumber: number, version }, validation.continuity.end);
    }
    const replaced = episode.activeVersionId && episode.activeVersionId !== id ? episode.activeVersionId : null;
    await tx.update(episodes).set({ activeVersionId: id }).where(eq(episodes.id, episode.id));
    if (replaced) await archiveProject(tx, replaced);
    await logEvent(tx, id, null, "info", `Episode ${number} version ${version} created from episode JSON (${ep.segments.length} segments).`, {
      warnings: validation.warnings.length,
    });
    if (replaced) {
      await logEvent(tx, replaced, null, "info", `Replaced by version ${version} (${id}); this version is stopped and kept.`);
    }
    return { projectId: id, episodeId: episode.id, version, replaced };
  });

  await refreshStoryStateCache(db, storyId);
  await revalidateLaterEpisodes(db, storyId, number);
  if (autoStart) await advance(db, id);
  return created;
}

export async function createProject(db: Db, rawJson: string, validation: ValidationResult): Promise<string> {
  return (await createVersion(db, rawJson, validation)).projectId;
}
