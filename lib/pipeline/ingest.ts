import "server-only";
import type { Db } from "@/lib/db";
import type { Episode } from "@/lib/episode/schema";
import { detectDocType, parseJsonText, validateText, type DocType, type ValidationResult } from "@/lib/episode/validate";
import { loadCastRegistry } from "./cast";
import { createVersion } from "./project";
import { getStory, loadStoryContext, mergeBibleAdditions, saveStory, type SaveStoryOutcome } from "./story";

function generalError(result: ValidationResult, path: string, message: string) {
  result.ok = false;
  result.errors.push({ level: "error", category: "general", path: [path], path_text: path, message, line: null, column: null });
}

/**
 * Validate any pasted document, checking episodes against their stored story (snapshots, masters). With
 * `scopeStoryId` (pasting inside a story folder) a document for another story is an error.
 */
export async function validateWithStore(db: Db, text: string, now?: Date, scopeStoryId?: string | null): Promise<ValidationResult> {
  const { raw, errors } = parseJsonText(text);
  if (errors.length) return validateText(text, { now });
  const { doc_type, story_id } = detectDocType(raw);
  const story = (doc_type === "episode" || doc_type === "bundle") && story_id ? await loadStoryContext(db, story_id) : null;
  const result = validateText(text, { now, story, registry: await loadCastRegistry(db) });
  if (scopeStoryId && story_id && story_id !== scopeStoryId) {
    generalError(
      result,
      "story_id",
      `This file belongs to story "${story_id}", not "${scopeStoryId}". Paste it on the New page (it files itself) or in its own story folder.`,
    );
  }
  if (doc_type === "episode" && !story && result.needs_story) {
    const row = await getStory(db, result.needs_story);
    generalError(
      result,
      "story_id",
      row?.status === "deleted"
        ? `Story "${row.title}" (${row.id}) is in the trash. Restore it before adding episodes.`
        : row
          ? `Story "${row.title}" has no story bible yet. Add the story bible first.`
          : `Story "${result.needs_story}" does not exist yet. Create the story (paste its story bible, or use New story), or paste a bundle.`,
    );
  }
  return result;
}

export interface IngestOutcome {
  docType: DocType | null;
  storyId: string | null;
  projectId: string | null;
  /** The new version's number, and the version it replaced (episodes and bundles). */
  version: number | null;
  replaced: string | null;
  bible: SaveStoryOutcome | null;
  validation: ValidationResult;
  error: string | null;
}

function firstError(v: ValidationResult): string {
  const first = v.errors[0];
  const where = first?.line ? ` (line ${first.line})` : "";
  return `${v.errors.length} error(s): ${first?.message ?? "invalid"}${where}`;
}

export interface IngestOptions {
  /** Changes the resolved episode before it is stored (import modes override automation). */
  adjust?: (ep: Episode) => void;
  /** Pasting inside a story folder: documents for other stories are refused. */
  scopeStoryId?: string | null;
}

/**
 * Store a story bible, an episode, or both (bundle). An episode becomes a new version of its episode number in
 * its story folder; nothing is overwritten.
 */
export async function ingestDocument(db: Db, text: string, options: IngestOptions | ((ep: Episode) => void) = {}): Promise<IngestOutcome> {
  const opts: IngestOptions = typeof options === "function" ? { adjust: options } : options;
  const validation = await validateWithStore(db, text, undefined, opts.scopeStoryId);
  const out: IngestOutcome = {
    docType: validation.doc_type,
    storyId: null,
    projectId: null,
    version: null,
    replaced: null,
    bible: null,
    validation,
    error: null,
  };
  if (!validation.ok) return { ...out, error: firstError(validation) };
  try {
    if (validation.story) {
      const saved = await saveStory(db, validation.story, text, validation.warnings);
      out.storyId = saved.storyId;
      out.bible = saved.outcome;
    }
    if (validation.episode) {
      opts.adjust?.(validation.episode);
      out.storyId = validation.episode.story.story_id;
      await mergeBibleAdditions(db, out.storyId, validation.episode_doc?.bible_additions, validation.episode.series.episode_number);
      const created = await createVersion(db, text, validation);
      out.projectId = created.projectId;
      out.version = created.version;
      out.replaced = created.replaced;
    }
  } catch (error) {
    return { ...out, error: (error as Error).message };
  }
  return out;
}
