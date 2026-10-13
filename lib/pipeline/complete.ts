import "server-only";
import { and, eq } from "drizzle-orm";
import { markAssetReady, pendingAssetsForTask, readyAssets } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { projects, segments, sfxCache, sfxCues, usageEvents, type TaskRow } from "@/lib/db/schema";
import type { Episode } from "@/lib/episode/schema";
import { logEvent } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { finalizeDescription, type SfxCredit } from "./description";

interface UsageItem {
  provider: string;
  unit: string;
  quantity: number;
  meta?: Record<string, unknown>;
}

/** Verify a worker's uploaded files exist in storage and mark them ready. Returns an error message on failure. */
export async function finalizeWorkerAssets(db: Db, task: TaskRow, assetIds: string[]): Promise<string | null> {
  const rows = await pendingAssetsForTask(db, task.id, assetIds);
  const found = new Set(rows.map((r) => r.id));
  const unknown = assetIds.filter((id) => !found.has(id));
  if (unknown.length) return `Unknown asset ids for this task: ${unknown.join(", ")}`;
  const storage = getStorage();
  for (const asset of rows) {
    if (asset.status === "ready") continue;
    const size = await storage.head(asset.storageKey);
    if (size === null) return `Asset ${asset.assetKey} (${asset.id}) was registered but never uploaded.`;
    await markAssetReady(db, asset, { sizeBytes: size });
  }
  return null;
}

async function recordUsage(db: Db, projectId: string, usage: unknown) {
  if (!Array.isArray(usage)) return;
  const rows = (usage as UsageItem[])
    .filter((u) => u && typeof u.provider === "string" && Number.isFinite(u.quantity))
    .map((u) => ({ projectId, provider: u.provider, unit: u.unit ?? "units", quantity: u.quantity, meta: u.meta ?? {} }));
  if (rows.length) await db.insert(usageEvents).values(rows);
}

interface SfxCandidate {
  provider: string;
  source_id: string;
  title?: string;
  author?: string;
  license: string;
  license_url?: string;
  source_url?: string;
  attribution_required?: boolean;
  duration_sec?: number;
  [key: string]: unknown;
}

export async function onTaskCompleted(db: Db, task: TaskRow, result: Record<string, unknown>): Promise<void> {
  const projectId = task.projectId;
  await recordUsage(db, projectId, result.usage);
  const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
  for (const w of warnings) await logEvent(db, projectId, task.id, "warning", String(w));

  switch (task.type) {
    case "voice": {
      for (const s of (result.segments as { segment_id: string; duration_sec: number }[]) ?? []) {
        await db
          .update(segments)
          .set({ audioDurationSec: s.duration_sec, updatedAt: new Date() })
          .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, s.segment_id)));
      }
      break;
    }
    case "align": {
      type AlignSeg = { segment_id: string; start_sec: number; end_sec: number; wer?: number; transcript?: string; flagged?: boolean };
      for (const s of (result.segments as AlignSeg[]) ?? []) {
        await db
          .update(segments)
          .set({
            startSec: s.start_sec,
            endSec: s.end_sec,
            qa: { wer: s.wer ?? null, transcript: s.transcript ?? null, flagged: Boolean(s.flagged) },
            updatedAt: new Date(),
          })
          .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, s.segment_id)));
        if (s.flagged) {
          await logEvent(db, projectId, task.id, "warning", `${s.segment_id}: TTS may have dropped or garbled words (WER ${(s.wer ?? 0).toFixed(2)}).`, {
            transcript: s.transcript,
          });
        }
      }
      break;
    }
    case "sfx": {
      type CueResult = { cue_id: string; segment_id: string; candidates: SfxCandidate[]; selected_index: number };
      for (const cue of (result.cues as CueResult[]) ?? []) {
        await db
          .insert(sfxCues)
          .values({ projectId, cueId: cue.cue_id, segmentId: cue.segment_id, candidates: cue.candidates, selectedIndex: cue.selected_index })
          .onConflictDoUpdate({
            target: [sfxCues.projectId, sfxCues.cueId],
            set: { candidates: cue.candidates, selectedIndex: cue.selected_index, updatedAt: new Date() },
          });
        const chosen = cue.candidates[cue.selected_index];
        if (chosen?.provider && chosen.source_id) {
          await db
            .insert(sfxCache)
            .values({
              clipKey: `${chosen.provider}:${chosen.source_id}`,
              provider: chosen.provider,
              sourceId: String(chosen.source_id),
              title: chosen.title ?? "",
              author: chosen.author ?? "",
              license: chosen.license,
              licenseUrl: chosen.license_url ?? "",
              sourceUrl: chosen.source_url ?? "",
              attributionRequired: Boolean(chosen.attribution_required),
              durationSec: chosen.duration_sec ?? null,
            })
            .onConflictDoNothing();
        }
      }
      break;
    }
    case "mix": {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      await db
        .update(projects)
        .set({ outputs: { ...(project.outputs as object), mix_report: result.report ?? null } })
        .where(eq(projects.id, projectId));
      break;
    }
    case "render": {
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      const ep = project.episode as Episode;
      const segRows = await db.select().from(segments).where(eq(segments.projectId, projectId));
      const starts = Object.fromEntries(segRows.filter((s) => s.startSec !== null).map((s) => [s.segmentId, s.startSec as number]));
      const credits: SfxCredit[] = (await readyAssets(db, projectId))
        .filter((a) => a.kind === "sfx")
        .map((a) => a.meta as unknown as SfxCredit)
        .filter((m) => m && typeof m.license === "string");
      const duration = Number(result.duration_sec ?? 0);
      const final = finalizeDescription(ep, starts, duration, credits);
      if (final.chapters_problem) {
        await logEvent(db, projectId, task.id, "warning", `Chapters left out of the description: ${final.chapters_problem}`);
      }
      await db
        .update(projects)
        .set({
          outputs: {
            ...(project.outputs as object),
            description: final.description,
            description_bytes: final.bytes,
            description_error: final.error,
            chapters: final.chapters,
            chapters_problem: final.chapters_problem,
            credits_text: final.credits_text,
            duration_sec: duration,
            verification: result.verification ?? null,
          },
        })
        .where(eq(projects.id, projectId));
      break;
    }
    case "upload_youtube": {
      await db
        .update(projects)
        .set({
          youtubeUrl: typeof result.youtube_url === "string" ? result.youtube_url : null,
          youtubeVideoId: typeof result.video_id === "string" ? result.video_id : null,
          publishedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
      await logEvent(db, projectId, task.id, "info", `Published: ${String(result.youtube_url ?? "(no URL returned)")}`);
      break;
    }
    default:
      break;
  }
}
