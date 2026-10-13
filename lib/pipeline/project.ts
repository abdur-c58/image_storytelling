import "server-only";
import { newId } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { projects, segments } from "@/lib/db/schema";
import { buildSegmentImageItem, segmentNeedsGeneratedImage } from "@/lib/episode/prompt";
import type { ValidationResult } from "@/lib/episode/validate";
import { logEvent } from "@/lib/queue";
import { advance } from "./advance";
import { orderedSegments } from "./requirements";

export async function createProject(db: Db, rawJson: string, validation: ValidationResult): Promise<string> {
  const ep = validation.episode;
  if (!validation.ok || !ep) throw new Error("Cannot create a project from an invalid episode.");
  const id = newId("prj");
  const autoStart = ep.automation.auto_start_on_submit;
  await db.insert(projects).values({
    id,
    seriesId: ep.series.series_id,
    episodeNumber: ep.series.episode_number,
    title: ep.youtube.title,
    state: autoStart ? "VALIDATED" : "DRAFT",
    stateDetail: autoStart ? "Starting…" : "Not started. Press Start to run the pipeline.",
    episode: ep,
    rawJson,
    estimate: validation.estimate ?? {},
    warnings: validation.warnings,
  });
  const rows = orderedSegments(ep).map((seg) => {
    const item = segmentNeedsGeneratedImage(seg) ? buildSegmentImageItem(ep, seg) : null;
    return {
      projectId: id,
      segmentId: seg.id,
      order: seg.order,
      type: seg.type,
      narration: seg.silent ? "" : seg.narration,
      finalPrompt: item?.final_prompt ?? null,
      negativePrompt: item?.negative_prompt ?? null,
    };
  });
  if (rows.length) await db.insert(segments).values(rows);
  await logEvent(db, id, null, "info", `Project created from episode JSON (${ep.segments.length} segments).`, {
    warnings: validation.warnings.length,
  });
  if (autoStart) await advance(db, id);
  return id;
}
