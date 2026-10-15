import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { markAssetReady, pendingAssetsForTask, readyAssets } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { assets, projects, segments, sfxCache, sfxCues, usageEvents, type TaskRow } from "@/lib/db/schema";
import type { LineTiming } from "@/lib/crop/timeline";
import type { Episode } from "@/lib/episode/schema";
import { spokenTagWords } from "@/lib/episode/tags";
import { logEvent, ownerOf } from "@/lib/queue";
import { getStorage } from "@/lib/storage";
import { regenerateVoice } from "./actions";
import { planCrops } from "./crop";
import { finalizeDescription, type SfxCredit } from "./description";
import { onStoryTaskCompleted } from "./story";

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
  const others = assetIds.filter((id) => !found.has(id));
  // Identical bytes are deduplicated at registration, which hands back the earlier task's ready asset.
  const reused = others.length
    ? await db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            inArray(assets.id, others),
            eq(assets.status, "ready"),
            task.projectId ? eq(assets.projectId, task.projectId) : eq(assets.storyId, task.storyId ?? ""),
          ),
        )
    : [];
  for (const r of reused) found.add(r.id);
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
  if (!task.projectId) {
    const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
    for (const w of warnings) await logEvent(db, ownerOf(task), task.id, "warning", String(w));
    await onStoryTaskCompleted(db, task);
    return;
  }
  const projectId = task.projectId;
  await recordUsage(db, projectId, result.usage);
  const warnings = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
  for (const w of warnings) await logEvent(db, projectId, task.id, "warning", String(w));

  switch (task.type) {
    case "voice": {
      type VoiceSeg = { segment_id: string; duration_sec: number; lines?: LineTiming[] };
      for (const s of (result.segments as VoiceSeg[]) ?? []) {
        const lineTimings = Array.isArray(s.lines)
          ? s.lines.filter((l) => l && typeof l.line_id === "string" && Number.isFinite(l.start) && Number.isFinite(l.end))
          : [];
        await db
          .update(segments)
          .set({ audioDurationSec: s.duration_sec, lineTimings, updatedAt: new Date() })
          .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, s.segment_id)));
      }
      break;
    }
    case "align": {
      type AlignSeg = { segment_id: string; start_sec: number; end_sec: number; wer?: number; transcript?: string; flagged?: boolean };
      const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
      const ep = project.episode as Episode;
      const byId = new Map(ep.segments.map((s) => [s.id, s]));
      const rows = new Map(
        (await db.select().from(segments).where(eq(segments.projectId, projectId))).map((r) => [r.segmentId, r]),
      );
      const fallbackSegments: string[] = [];
      for (const s of (result.segments as AlignSeg[]) ?? []) {
        const src = byId.get(s.segment_id);
        const prev = rows.get(s.segment_id);
        const prevQa = (prev?.qa ?? {}) as { tag_leak_count?: number };
        const leaked = src?.tts_text && s.transcript ? spokenTagWords(src.tts_text, src.narration, s.transcript) : [];
        const leakCount = (prevQa.tag_leak_count ?? 0) + (leaked.length ? 1 : 0);
        await db
          .update(segments)
          .set({
            startSec: s.start_sec,
            endSec: s.end_sec,
            qa: {
              wer: s.wer ?? null,
              transcript: s.transcript ?? null,
              flagged: Boolean(s.flagged),
              tag_leak: leaked,
              tag_leak_count: leakCount,
            },
            updatedAt: new Date(),
          })
          .where(and(eq(segments.projectId, projectId), eq(segments.segmentId, s.segment_id)));
        if (s.flagged) {
          await logEvent(db, projectId, task.id, "warning", `${s.segment_id}: TTS may have dropped or garbled words (WER ${(s.wer ?? 0).toFixed(2)}).`, {
            transcript: s.transcript,
          });
        }
        if (leaked.length) {
          const canFallBack = ep.voice?.tag_fallback_mode === "split_and_silence" && prev?.voiceMode !== "split_and_silence";
          if (leakCount >= 2 && canFallBack) {
            fallbackSegments.push(s.segment_id);
            await logEvent(db, projectId, task.id, "warning", `${s.segment_id}: tag words spoken aloud again (${leaked.join(", ")}); switching to split-and-silence and re-voicing.`);
          } else {
            await logEvent(
              db,
              projectId,
              task.id,
              "warning",
              `${s.segment_id}: Fish seems to have read tag words aloud (${leaked.join(", ")}). Regenerate the voice${canFallBack ? "; if it happens again the segment switches to split-and-silence" : ""}.`,
            );
          }
        }
      }
      await planCrops(db, projectId);
      if (fallbackSegments.length) {
        await db
          .update(segments)
          .set({ voiceMode: "split_and_silence", updatedAt: new Date() })
          .where(and(eq(segments.projectId, projectId), inArray(segments.segmentId, fallbackSegments)));
        for (const id of fallbackSegments) await regenerateVoice(db, projectId, id);
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
      const { seriesNavFor } = await import("./folders");
      const final = finalizeDescription(ep, starts, duration, credits, await seriesNavFor(db, projectId));
      if (final.chapters_problem) {
        await logEvent(db, projectId, task.id, "warning", `Chapters left out of the description: ${final.chapters_problem}`);
      }
      await db
        .update(projects)
        .set({
          outputs: {
            ...(project.outputs as object),
            description: final.description,
            description_template: final.template,
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
      const { refreshNeighbourNav } = await import("./folders");
      await refreshNeighbourNav(db, projectId);
      break;
    }
    default:
      break;
  }
}
