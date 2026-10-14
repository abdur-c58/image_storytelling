"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { createApiToken, requireAdmin, revokeApiToken, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { logEvent } from "@/lib/queue";
import type { ValidationResult } from "@/lib/episode/validate";
import {
  approveGate,
  archiveProject,
  deleteProject,
  regenerateImage,
  regenerateThumbnailBase,
  regenerateVoice,
  rerender,
  retryFailed,
  startProject,
  swapSfx,
} from "@/lib/pipeline/actions";
import { rerollCrops, setSegmentCrop } from "@/lib/pipeline/crop";
import { ingestDocument, validateWithStore } from "@/lib/pipeline/ingest";
import {
  approveAllGenerated,
  approveMaster,
  commitStoryState,
  deleteStory,
  regenerateMaster,
} from "@/lib/pipeline/story";

export interface CreateState {
  error: string | null;
}

/** Story bible → Story page; episode or bundle → the new project. */
export async function createProjectAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  await requireAdmin();
  const text = String(form.get("episode") ?? "");
  if (text.length > 1_000_000) return { error: "Document is larger than 1 MB." };
  const out = await ingestDocument(await getDb(), text);
  if (out.error) return { error: out.error };
  if (out.projectId) redirect(`/projects/${out.projectId}`);
  if (out.storyId) redirect(`/stories/${out.storyId}`);
  return { error: "Nothing was stored." };
}

/** Full validation including continuity against the stored story (the editor's client check cannot see it). */
export async function validateDocumentAction(text: string): Promise<ValidationResult> {
  await requireAdmin();
  if (text.length > 1_000_000) {
    return {
      ok: false,
      doc_type: null,
      story: null,
      episode_doc: null,
      episode: null,
      needs_story: null,
      continuity: null,
      errors: [{ level: "error", path: [], path_text: "(root)", message: "Document is larger than 1 MB.", line: null, column: null }],
      warnings: [],
      estimate: null,
    };
  }
  return validateWithStore(await getDb(), text);
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
  | { kind: "reroll_crops"; segmentId?: string }
  | { kind: "crop_toggle"; segmentId: string; enabled: boolean | null }
  | { kind: "commit_story_state" }
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
      case "reroll_crops":
        await rerollCrops(db, projectId, action.segmentId);
        break;
      case "crop_toggle":
        await setSegmentCrop(db, projectId, action.segmentId, action.enabled);
        break;
      case "commit_story_state":
        if (!(await commitStoryState(db, projectId))) throw new Error("This episode has no story state to commit.");
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

export async function deleteProjectAction(projectId: string, typedTitle: string): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  try {
    const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId));
    if (!project) return { error: "Project not found." };
    if (typedTitle.trim() !== project.title.trim()) return { error: "The title you typed doesn't match." };
    await deleteProject(db, projectId);
  } catch (error) {
    return { error: `Delete failed (${(error as Error).message}). The project is still here; try again.` };
  }
  redirect("/projects");
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
): Promise<{ id: string | null; storyId: string | null; error: string | null; replaced: number }> {
  await requireAdmin();
  if (text.length > 1_000_000) return { id: null, storyId: null, error: "File is larger than 1 MB.", replaced: 0 };
  const db = await getDb();
  let replaced = 0;
  const out = await ingestDocument(db, text, (ep) => {
    if (mode !== "as_written") {
      ep.automation = {
        ...ep.automation,
        auto_start_on_submit: mode !== "import_only",
        approval_gates: { ...ep.automation.approval_gates, before_render: false, before_publish: mode === "review" },
      };
    }
  });
  if (out.error) return { id: null, storyId: out.storyId, error: out.error, replaced: 0 };
  const ep = out.validation.episode;
  if (out.projectId && ep && replaceExisting) {
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
      if (p.id === out.projectId) continue;
      await archiveProject(db, p.id);
      replaced++;
    }
  }
  if (out.projectId) await logEvent(db, out.projectId, null, "info", MODE_NOTE[mode]);
  refresh();
  return { id: out.projectId, storyId: out.storyId, error: null, replaced };
}

export type StoryAction =
  | { kind: "approve_master"; masterKey: string; assetId?: string }
  | { kind: "approve_all" }
  | { kind: "regen_master"; masterKey: string }
  | { kind: "commit_state"; projectId: string };

export async function storyAction(storyId: string, action: StoryAction): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  try {
    switch (action.kind) {
      case "approve_master":
        await approveMaster(db, storyId, action.masterKey, action.assetId);
        break;
      case "approve_all":
        await approveAllGenerated(db, storyId);
        break;
      case "regen_master":
        await regenerateMaster(db, storyId, action.masterKey);
        break;
      case "commit_state":
        if (!(await commitStoryState(db, action.projectId))) throw new Error("That episode has no story state to commit.");
        break;
    }
  } catch (error) {
    unstable_rethrow(error);
    return { error: (error as Error).message };
  }
  refresh();
  return { error: null };
}

export async function deleteStoryAction(storyId: string, typedId: string): Promise<{ error: string | null }> {
  await requireAdmin();
  if (typedId.trim() !== storyId) return { error: "The story id you typed doesn't match." };
  try {
    await deleteStory(await getDb(), storyId);
  } catch (error) {
    return { error: `Delete failed (${(error as Error).message}).` };
  }
  redirect("/stories");
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
