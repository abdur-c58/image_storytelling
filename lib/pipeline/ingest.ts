import "server-only";
import type { Db } from "@/lib/db";
import type { Episode } from "@/lib/episode/schema";
import { detectDocType, parseJsonText, validateText, type DocType, type ValidationResult } from "@/lib/episode/validate";
import { loadCastRegistry } from "./cast";
import { createProject } from "./project";
import { loadStoryContext, mergeBibleAdditions, saveStory } from "./story";

/** Validate any pasted document, checking episodes against their stored story (state, masters). */
export async function validateWithStore(db: Db, text: string, now?: Date): Promise<ValidationResult> {
  const { raw, errors } = parseJsonText(text);
  if (errors.length) return validateText(text, { now });
  const { doc_type, story_id } = detectDocType(raw);
  const story = (doc_type === "episode" || doc_type === "bundle") && story_id ? await loadStoryContext(db, story_id) : null;
  const result = validateText(text, { now, story, registry: await loadCastRegistry(db) });
  if (doc_type === "episode" && !story && result.needs_story) {
    result.errors.push({
      level: "error",
      category: "general",
      path: ["story_id"],
      path_text: "story_id",
      message: `Story "${result.needs_story}" does not exist yet. Paste its story bible first, or paste a bundle.`,
      line: null,
      column: null,
    });
  }
  return result;
}

export interface IngestOutcome {
  docType: DocType | null;
  storyId: string | null;
  projectId: string | null;
  validation: ValidationResult;
  error: string | null;
}

function firstError(v: ValidationResult): string {
  const first = v.errors[0];
  const where = first?.line ? ` (line ${first.line})` : "";
  return `${v.errors.length} error(s): ${first?.message ?? "invalid"}${where}`;
}

/**
 * Store a story bible, an episode, or both (bundle). `adjust` may change the resolved episode before it is
 * stored (import modes override automation).
 */
export async function ingestDocument(db: Db, text: string, adjust?: (ep: Episode) => void): Promise<IngestOutcome> {
  const validation = await validateWithStore(db, text);
  const out: IngestOutcome = { docType: validation.doc_type, storyId: null, projectId: null, validation, error: null };
  if (!validation.ok) return { ...out, error: firstError(validation) };
  try {
    if (validation.story) {
      const { storyId } = await saveStory(db, validation.story, text, validation.warnings);
      out.storyId = storyId;
    }
    if (validation.episode) {
      if (adjust) adjust(validation.episode);
      out.storyId = validation.episode.story.story_id;
      await mergeBibleAdditions(db, out.storyId, validation.episode_doc?.bible_additions, validation.episode.series.episode_number);
      out.projectId = await createProject(db, text, validation);
    }
  } catch (error) {
    return { ...out, error: (error as Error).message };
  }
  return out;
}
