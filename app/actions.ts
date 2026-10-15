"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { createApiToken, requireAdmin, revokeApiToken, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { episodeHref } from "@/lib/episode/naming";
import { logEvent } from "@/lib/queue";
import type { ValidationResult } from "@/lib/episode/validate";
import {
  approveGate,
  redoMasterAndRetry,
  regenerateImage,
  regenerateThumbnailBase,
  regenerateVoice,
  rerender,
  retryFailed,
  startProject,
  swapSfx,
} from "@/lib/pipeline/actions";
import { rerollCrops, setSegmentCrop } from "@/lib/pipeline/crop";
import {
  activateVersion,
  createEmptyStory,
  deleteTrashedStory,
  deleteVersion,
  duplicateVersion,
  planIngest,
  renameStory,
  restoreStory,
  setStoryArchived,
  softDeleteStory,
  updateStorySettings,
  type IngestPlan,
} from "@/lib/pipeline/folders";
import { ingestDocument, validateWithStore } from "@/lib/pipeline/ingest";
import {
  approveAllGenerated,
  approveMaster,
  commitStoryState,
  promoteCharacter,
  regenerateMaster,
  requestVoiceSample,
} from "@/lib/pipeline/story";
import { saveVoiceSettings, setStoryVoice, type VoiceSettings } from "@/lib/pipeline/voices";

export interface CreateState {
  error: string | null;
}

const storyHref = (storyId: string) => `/stories/${encodeURIComponent(storyId)}`;

/** Drizzle wraps database errors as "Failed query: <sql> params: …"; the reason is in `cause`. */
function errorText(error: unknown): string {
  const e = error as Error;
  const cause = e?.cause as Error | undefined;
  if (cause?.message && e.message?.startsWith("Failed query")) return `Database error: ${cause.message}. Try again in a moment.`;
  return e?.message ?? String(error);
}

/** Story bible → its folder; episode or bundle → the new episode version. `scope` limits it to one folder. */
export async function createProjectAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  await requireAdmin();
  const text = String(form.get("episode") ?? "");
  const scope = String(form.get("scope") ?? "") || null;
  if (text.length > 1_000_000) return { error: "Document is larger than 1 MB." };
  const out = await ingestDocument(await getDb(), text, { scopeStoryId: scope });
  if (out.error) return { error: out.error };
  const ep = out.validation.episode;
  if (out.projectId && ep) redirect(episodeHref(ep.story.story_id, ep.series.episode_number));
  if (out.storyId) redirect(storyHref(out.storyId));
  return { error: "Nothing was stored." };
}

/** What a paste would do (create story, add episode, new version …), for the confirmation dialog. */
export async function planIngestAction(text: string, scope?: string | null): Promise<IngestPlan> {
  await requireAdmin();
  if (text.length > 1_000_000) {
    return {
      ok: false,
      docType: null,
      action: null,
      storyId: null,
      storyTitle: null,
      episodeNumber: null,
      episodeTitle: null,
      nextVersion: null,
      replaces: null,
      summary: "",
      diff: [],
      warnings: [],
      errors: [{ message: "Document is larger than 1 MB." }],
    };
  }
  return planIngest(await getDb(), text, scope ?? null);
}

/** Full validation including continuity against the stored story (the editor's client check cannot see it). */
export async function validateDocumentAction(text: string, scope?: string | null): Promise<ValidationResult> {
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
      errors: [{ level: "error", category: "general", path: [], path_text: "(root)", message: "Document is larger than 1 MB.", line: null, column: null }],
      warnings: [],
      estimate: null,
      identification: null,
      structure: null,
    };
  }
  return validateWithStore(await getDb(), text, undefined, scope ?? null);
}

export type ProjectAction =
  | { kind: "start" }
  | { kind: "retry"; taskId?: string }
  | { kind: "redo_master_retry"; masterKey: string }
  | { kind: "regen_image"; segmentId: string }
  | { kind: "regen_thumbnail" }
  | { kind: "regen_voice"; segmentId: string }
  | { kind: "swap_sfx"; cueId: string; index: number }
  | { kind: "rerender" }
  | { kind: "approve"; gate: "render" | "publish" }
  | { kind: "reroll_crops"; segmentId?: string }
  | { kind: "crop_toggle"; segmentId: string; enabled: boolean | null }
  | { kind: "commit_story_state" };

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
      case "redo_master_retry":
        await redoMasterAndRetry(db, projectId, action.masterKey);
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
    }
  } catch (error) {
    unstable_rethrow(error);
    return { error: errorText(error) };
  }
  refresh();
  return { error: null };
}

export type VersionAction = { kind: "activate" } | { kind: "duplicate" };

export async function versionAction(projectId: string, action: VersionAction): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  let target: string | null = null;
  try {
    if (action.kind === "activate") await activateVersion(db, projectId);
    else target = await duplicateVersion(db, projectId);
  } catch (error) {
    return { error: errorText(error) };
  }
  if (target) {
    const [p] = await db.select({ storyId: projects.storyId, n: projects.episodeNumber, v: projects.version }).from(projects).where(eq(projects.id, target));
    if (p?.storyId) redirect(episodeHref(p.storyId, p.n, p.v));
  }
  refresh();
  return { error: null };
}

/** Delete one version (typed title confirmation). The last version takes the episode with it. */
export async function deleteProjectAction(projectId: string, typedTitle: string): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  let back = "/stories";
  try {
    const [project] = await db
      .select({ title: projects.title, storyId: projects.storyId, n: projects.episodeNumber })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project) return { error: "Version not found." };
    if (typedTitle.trim() !== project.title.trim()) return { error: "The title you typed doesn't match." };
    const { episodeRemoved } = await deleteVersion(db, projectId);
    if (project.storyId) back = episodeRemoved ? storyHref(project.storyId) : episodeHref(project.storyId, project.n);
  } catch (error) {
    return { error: `Delete failed (${errorText(error)}). The version is still here; try again.` };
  }
  redirect(back);
}

/** How a dropped episode should run, overriding the file's own `automation` block. */
export type ImportMode = "publish" | "review" | "import_only" | "as_written";

const MODE_NOTE: Record<ImportMode, string> = {
  publish: "Automation chosen on import: run through to publishing.",
  review: "Automation chosen on import: stop for review before publishing.",
  import_only: "Automation chosen on import: import only (not started).",
  as_written: "Automation chosen on import: as written in the episode file.",
};

export interface ImportResult {
  id: string | null;
  storyId: string | null;
  episodeNumber: number | null;
  version: number | null;
  /** Link to what was stored (the episode version or the story folder). */
  href: string | null;
  error: string | null;
}

/**
 * Store a dropped/pasted document after its plan was confirmed. A repeated episode number becomes a new
 * version (the previous one is stopped and kept). `scope` refuses documents for other story folders.
 */
export async function importEpisodeAction(text: string, mode: ImportMode, scope?: string | null): Promise<ImportResult> {
  await requireAdmin();
  const none = { id: null, storyId: null, episodeNumber: null, version: null, href: null };
  if (text.length > 1_000_000) return { ...none, error: "File is larger than 1 MB." };
  const db = await getDb();
  const out = await ingestDocument(db, text, {
    scopeStoryId: scope ?? null,
    adjust: (ep) => {
      if (mode !== "as_written") {
        ep.automation = {
          ...ep.automation,
          auto_start_on_submit: mode !== "import_only",
          approval_gates: { ...ep.automation.approval_gates, before_render: false, before_publish: mode === "review" },
        };
      }
    },
  });
  if (out.error) return { ...none, storyId: out.storyId, error: out.error };
  const ep = out.validation.episode;
  if (out.projectId) await logEvent(db, out.projectId, null, "info", MODE_NOTE[mode]);
  refresh();
  return {
    id: out.projectId,
    storyId: out.storyId,
    episodeNumber: ep?.series.episode_number ?? null,
    version: out.version,
    href: out.projectId && ep ? episodeHref(ep.story.story_id, ep.series.episode_number) : out.storyId ? storyHref(out.storyId) : null,
    error: null,
  };
}

export type StoryAction =
  | { kind: "approve_master"; masterKey: string; assetId?: string }
  | { kind: "approve_all" }
  | { kind: "regen_master"; masterKey: string }
  | { kind: "commit_state"; projectId: string }
  | { kind: "test_voice"; speaker: string; text?: string }
  | { kind: "promote_character"; characterId: string }
  | { kind: "set_voice"; speaker: string; voiceId: string }
  | { kind: "rename"; title: string }
  | { kind: "settings"; description?: string; defaultsOverride?: unknown }
  | { kind: "archive"; archived: boolean }
  | { kind: "restore" };

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
      case "test_voice":
        await requestVoiceSample(db, storyId, action.speaker, action.text);
        break;
      case "promote_character":
        await promoteCharacter(db, storyId, action.characterId);
        break;
      case "set_voice":
        await setStoryVoice(db, storyId, action.speaker, action.voiceId);
        break;
      case "rename":
        await renameStory(db, storyId, action.title);
        break;
      case "settings":
        await updateStorySettings(db, storyId, { description: action.description, defaultsOverride: action.defaultsOverride });
        break;
      case "archive":
        await setStoryArchived(db, storyId, action.archived);
        break;
      case "restore":
        await restoreStory(db, storyId);
        break;
    }
  } catch (error) {
    unstable_rethrow(error);
    return { error: errorText(error) };
  }
  refresh();
  return { error: null };
}

/** "New story": an empty, named folder. */
export async function createStoryAction(input: { title: string; slug: string; description?: string }): Promise<{ error: string | null }> {
  await requireAdmin();
  let id: string;
  try {
    id = await createEmptyStory(await getDb(), input);
  } catch (error) {
    return { error: errorText(error) };
  }
  redirect(storyHref(id));
}

/** Move to the trash (typed name), or delete forever from the trash. */
export async function deleteStoryAction(storyId: string, typedTitle: string, forever = false): Promise<{ error: string | null }> {
  await requireAdmin();
  const db = await getDb();
  try {
    if (forever) await deleteTrashedStory(db, storyId, typedTitle);
    else await softDeleteStory(db, storyId, typedTitle);
  } catch (error) {
    return { error: errorText(error) };
  }
  redirect((forever ? "/stories?trash=1" : "/stories"));
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

export async function saveVoiceSettingsAction(settings: VoiceSettings): Promise<{ error: string | null }> {
  await requireAdmin();
  try {
    await saveVoiceSettings(await getDb(), settings);
  } catch (error) {
    return { error: errorText(error) };
  }
  refresh();
  return { error: null };
}
