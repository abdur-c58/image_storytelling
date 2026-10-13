"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { createApiToken, requireAdmin, revokeApiToken, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { logEvent } from "@/lib/queue";
import { validateEpisodeText } from "@/lib/episode/validate";
import {
  approveGate,
  archiveProject,
  regenerateImage,
  regenerateThumbnailBase,
  regenerateVoice,
  rerender,
  retryFailed,
  startProject,
  swapSfx,
} from "@/lib/pipeline/actions";
import { createProject } from "@/lib/pipeline/project";

export interface CreateState {
  error: string | null;
}

export async function createProjectAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  await requireAdmin();
  const text = String(form.get("episode") ?? "");
  const result = validateEpisodeText(text);
  if (!result.ok) return { error: `The episode has ${result.errors.length} error(s); fix them first.` };
  const id = await createProject(await getDb(), text, result);
  redirect(`/projects/${id}`);
}

export type ProjectAction =
  | { kind: "start" }
  | { kind: "retry"; taskId?: string }
  | { kind: "regen_image"; segmentId: string }
  | { kind: "regen_thumbnail" }
  | { kind: "regen_voice"; segmentId: string }
  | { kind: "swap_sfx"; cueId: string; index: number }
  | { kind: "rerender" }
  | { kind: "approve"; gate: "render" | "publish" }
  | { kind: "archive" };

export async function projectAction(projectId: string, action: ProjectAction): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  try {
    switch (action.kind) {
      case "start":
        await startProject(db, projectId);
        break;
      case "retry":
        await retryFailed(db, projectId, action.taskId);
        break;
      case "regen_image":
        await regenerateImage(db, projectId, action.segmentId);
        break;
      case "regen_thumbnail":
        await regenerateThumbnailBase(db, projectId);
        break;
      case "regen_voice":
        await regenerateVoice(db, projectId, action.segmentId);
        break;
      case "swap_sfx":
        await swapSfx(db, projectId, action.cueId, action.index);
        break;
      case "rerender":
        await rerender(db, projectId);
        break;
      case "approve":
        await approveGate(db, projectId, action.gate);
        break;
      case "archive":
        await archiveProject(db, projectId);
        redirect("/projects");
    }
  } catch (error) {
    unstable_rethrow(error);
    return { error: (error as Error).message };
  }
  refresh();
  return { error: null };
}

/** How a dropped episode should run, overriding the file's own `automation` block. */
export type ImportMode = "publish" | "review" | "import_only" | "as_written";

const MODE_NOTE: Record<ImportMode, string> = {
  publish: "Automation chosen on import: run through to publishing.",
  review: "Automation chosen on import: stop for review before publishing.",
  import_only: "Automation chosen on import: import only (not started).",
  as_written: "Automation chosen on import: as written in the episode file.",
};

export async function importEpisodeAction(
  text: string,
  mode: ImportMode,
  replaceExisting: boolean,
): Promise<{ id: string | null; error: string | null; replaced: number }> {
  await requireAdmin();
  if (text.length > 1_000_000) return { id: null, error: "File is larger than 1 MB.", replaced: 0 };
  const result = validateEpisodeText(text);
  if (!result.ok || !result.episode) {
    const first = result.errors[0];
    const where = first?.line ? ` (line ${first.line})` : "";
    return { id: null, error: `${result.errors.length} error(s): ${first?.message ?? "invalid"}${where}`, replaced: 0 };
  }
  const ep = result.episode;
  if (mode !== "as_written") {
    ep.automation = {
      ...ep.automation,
      auto_start_on_submit: mode !== "import_only",
      approval_gates: { ...ep.automation.approval_gates, before_render: false, before_publish: mode === "review" },
    };
  }
  const db = await getDb();
  let replaced = 0;
  if (replaceExisting) {
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.seriesId, ep.series.series_id),
          eq(projects.episodeNumber, ep.series.episode_number),
          eq(projects.archived, false),
        ),
      );
    for (const p of existing) {
      await archiveProject(db, p.id);
      replaced++;
    }
  }
  const id = await createProject(db, text, result);
  await logEvent(db, id, null, "info", MODE_NOTE[mode]);
  refresh();
  return { id, error: null, replaced };
}

export async function createTokenAction(name: string, role: Role): Promise<{ token: string }> {
  await requireAdmin();
  const clean = name.trim().slice(0, 60) || `${role} token`;
  const { token } = await createApiToken(clean, role);
  refresh();
  return { token };
}

export async function revokeTokenAction(id: string): Promise<void> {
  await requireAdmin();
  await revokeApiToken(id);
  refresh();
}
