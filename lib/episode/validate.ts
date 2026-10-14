import { findNodeAtLocation, parse, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { z } from "zod";
import {
  CROP_HARD_CAP,
  KNOWN_ICONS,
  MAX_RUNTIME_WARNING_SEC,
  MAX_SEGMENT_WORDS_WARNING,
  MIN_RUNTIME_WARNING_SEC,
  SCHEMA_VERSION,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_TAGS_MAX_CHARS,
  YOUTUBE_TITLE_MAX,
} from "./constants";
import {
  checkBibleAdditions,
  checkContinuity,
  checkStoryBible,
  masterKeyForOutfit,
  masterKeyForView,
  startSnapshotFor,
  type ContinuityResult,
  type IssuePath,
  type StoryState,
  type StoryStateSnapshot,
} from "./continuity";
import { countWords, estimateEpisode, type EpisodeEstimate } from "./estimate";
import { applyBibleAdditions, mergeCropPolicy, resolveEpisode } from "./resolve";
import {
  BundleSchema,
  EpisodeDocSchema,
  StoryBibleSchema,
  VoiceSchema,
  type CropPolicy,
  type Episode,
  type EpisodeDoc,
  type StoryBible,
  type Voice,
} from "./schema";
import { segmentSentences } from "./sentences";
import { firstMismatch, normalizeTagName, parseTags, tagStats, ttsMatchesNarration } from "./tags";
import { normalizePhrase, phraseInText } from "./text";
import { hasForbiddenYoutubeChars, utf8ByteLength, youtubeTagsLength } from "./youtube";

export type { IssuePath } from "./continuity";
export type DocType = "story_bible" | "episode" | "bundle";

export interface ValidationIssue {
  level: "error" | "warning";
  path: IssuePath;
  path_text: string;
  message: string;
  line: number | null;
  column: number | null;
}

/** The stored story an episode is checked against. */
export interface StoryContext {
  bible: StoryBible;
  state: StoryState | null;
  /** Master keys (loc/…, char/…) that have an approved image. */
  approvedMasters?: Set<string>;
  /** Whether the story requires approved masters before images are generated. */
  mastersGate?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  doc_type: DocType | null;
  /** The story bible (story_bible and bundle documents). */
  story: StoryBible | null;
  /** The episode as written (episode and bundle documents). */
  episode_doc: EpisodeDoc | null;
  /** The resolved episode, when its story is known. */
  episode: Episode | null;
  /** An episode whose story was not provided: continuity was not checked yet. */
  needs_story: string | null;
  continuity: (ContinuityResult & { start: StoryStateSnapshot }) | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  estimate: EpisodeEstimate | null;
}

type Locator = (path: IssuePath) => { line: number; column: number } | null;

function pathText(path: IssuePath): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${part}` : part;
  }
  return out || "(root)";
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

function offsetToLineColumn(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

function makeLocator(text: string): Locator {
  const root = parseTree(text);
  const starts = lineStarts(text);
  return (path) => {
    if (!root) return null;
    for (let depth = path.length; depth >= 0; depth--) {
      const node: Node | undefined = findNodeAtLocation(root, path.slice(0, depth));
      if (node) {
        // Point at the property key when the node is a property value.
        const target = node.parent?.type === "property" ? node.parent : node;
        return offsetToLineColumn(starts, target.offset);
      }
    }
    return null;
  };
}

class IssueCollector {
  errors: ValidationIssue[] = [];
  warnings: ValidationIssue[] = [];
  constructor(private locate: Locator | null) {}

  add(level: "error" | "warning", path: IssuePath, message: string) {
    const location = this.locate?.(path) ?? null;
    const issue: ValidationIssue = {
      level,
      path,
      path_text: pathText(path),
      message,
      line: location?.line ?? null,
      column: location?.column ?? null,
    };
    (level === "error" ? this.errors : this.warnings).push(issue);
  }
  error(path: IssuePath, message: string) {
    this.add("error", path, message);
  }
  warn(path: IssuePath, message: string) {
    this.add("warning", path, message);
  }
}

function zodIssues(error: z.ZodError, issues: IssueCollector, raw: unknown, prefix: IssuePath = []) {
  for (const issue of error.issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    let message = issue.message;
    // Name the segment so the message is readable without counting array indices.
    const si = path.indexOf("segments");
    if (si >= 0 && typeof path[si + 1] === "number") {
      const scope = (si === 0 ? raw : (raw as Record<string, unknown>)?.[String(path[0])]) as { segments?: Array<{ id?: unknown }> };
      const seg = scope?.segments?.[path[si + 1] as number];
      if (seg && typeof seg.id === "string") message = `${seg.id}: ${message}`;
    }
    issues.error([...prefix, ...path], message);
  }
}

export function checkCropPolicy(policy: CropPolicy, issues: IssueCollector, path: IssuePath) {
  if (policy.min_crop > policy.typical_max_crop) issues.error([...path, "min_crop"], "min_crop must not exceed typical_max_crop.");
  if (policy.typical_max_crop > policy.max_crop) issues.error([...path, "typical_max_crop"], "typical_max_crop must not exceed max_crop.");
  if (policy.max_crop > CROP_HARD_CAP) issues.error([...path, "max_crop"], `max_crop is capped at ${CROP_HARD_CAP}.`);
  const weights = Object.values(policy.sentences_before_crop);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!weights.length) issues.error([...path, "sentences_before_crop"], "sentences_before_crop needs at least one entry.");
  else if (Math.abs(sum - 1) > 0.001) issues.error([...path, "sentences_before_crop"], `Probabilities must add up to 1 (they add up to ${sum}).`);
}

const LEGACY_IMAGE_FIELDS = ["motion", "characters_present", "shot_type", "mood", "time_of_day"] as const;

/** Checks that need only the episode itself (ids, order, cards, tags, sfx, YouTube, chapters, triggers). */
function checkEpisodeDoc(doc: EpisodeDoc, voice: Voice, issues: IssueCollector, now: Date, prefix: IssuePath) {
  const segIndex = new Map<string, number>();
  const sfxIds = new Map<string, string>();
  const P = (...p: IssuePath) => [...prefix, ...p];
  const segments = doc.segments;

  segments.forEach((seg, i) => {
    if (segIndex.has(seg.id)) issues.error(P("segments", i, "id"), `Duplicate segment id "${seg.id}".`);
    else segIndex.set(seg.id, i);
  });
  const orders = segments.map((s) => s.order).sort((a, b) => a - b);
  orders.forEach((order, i) => {
    if (order !== i + 1) {
      const idx = segments.findIndex((s) => s.order === order);
      issues.error(
        P("segments", idx, "order"),
        `Segment "order" values must be contiguous from 1 with no duplicates (expected ${i + 1}, found ${order}).`,
      );
    }
  });
  const orderOf = (id: string) => {
    const idx = segIndex.get(id);
    return idx === undefined ? null : segments[idx].order;
  };
  const hasPicture = (id: string) => {
    const idx = segIndex.get(id);
    if (idx === undefined) return false;
    const s = segments[idx];
    return (
      s.type === "illustration" ||
      s.type === "reuse_image" ||
      (s.remotion?.props.background === "image" && !!s.image?.prompt.trim())
    );
  };

  const whitelist = new Set(voice.tag_whitelist.map(normalizeTagName));
  const paired = new Set(voice.paired_tags.map((t) => t.toLowerCase()));

  segments.forEach((seg, i) => {
    const at = (...rest: IssuePath) => P("segments", i, ...rest);
    const label = seg.id;
    const words = countWords(seg.narration);

    if (!seg.silent && !seg.narration.trim()) {
      issues.error(at("narration"), `${label}: "narration" is required unless "silent" is true.`);
    }
    if (seg.silent && seg.narration.trim()) {
      issues.warn(at("narration"), `${label}: segment is silent, so its narration will not be spoken.`);
    }
    if (words > MAX_SEGMENT_WORDS_WARNING) {
      issues.warn(at("narration"), `${label}: ${words} words is long for one image (over ${MAX_SEGMENT_WORDS_WARNING}). Consider splitting.`);
    }

    // Voice tags: narration stays clean; tts_text carries the tags and must say the same words.
    if (/[[\]]/.test(seg.narration) || /<\/?[a-z][a-z-]*>/i.test(seg.narration)) {
      issues.error(at("narration"), `${label}: narration must be clean text; put [tags] and <tags> in "tts_text".`);
    }
    if (seg.tts_text !== null && !seg.silent) {
      const parsed = parseTags(seg.tts_text);
      for (const p of parsed.problems) issues.error(at("tts_text"), `${label}: ${p.message} (character ${p.index + 1})`);
      if (!ttsMatchesNarration(seg.tts_text, seg.narration)) {
        const m = firstMismatch(seg.tts_text, seg.narration);
        issues.error(
          at("tts_text"),
          `${label}: tts_text without tags must match narration word for word${m ? ` (tts_text has "${m.tts}", narration has "${m.narration}")` : ""}.`,
        );
      }
      const stats = tagStats(parsed.tokens);
      for (const cue of new Set(stats.cues)) {
        if (!whitelist.has(cue)) {
          const msg = `${label}: [${cue}] is not in voice.tag_whitelist; Fish may read it aloud.`;
          if (voice.unknown_tag_level === "error") issues.error(at("tts_text"), msg);
          else issues.warn(at("tts_text"), msg);
        }
      }
      for (const tag of new Set(stats.paired)) {
        if (!paired.has(tag)) issues.error(at("tts_text"), `${label}: <${tag}> is not a supported paired tag (${[...paired].join(", ")}).`);
      }
      const density = words ? (stats.total / words) * 100 : stats.total ? Infinity : 0;
      if (density > voice.max_tags_per_100_words) {
        issues.warn(
          at("tts_text"),
          `${label}: ${stats.total} tags for ${words} words is dense (limit ${voice.max_tags_per_100_words} per 100 words); heavy tagging degrades delivery.`,
        );
      }
    }
    if (seg.sentence_split_override) {
      const joined = normalizePhrase(seg.sentence_split_override.join(" "));
      if (joined !== normalizePhrase(seg.narration)) {
        issues.error(at("sentence_split_override"), `${label}: sentence_split_override must contain exactly the narration's words, in order.`);
      }
    }
    if (!seg.silent && seg.narration.trim() && segmentSentences(seg).length === 0) {
      issues.error(at("narration"), `${label}: no sentences found in narration.`);
    }

    if (seg.type === "illustration") {
      if (!seg.image) issues.error(at("image"), `${label}: illustration needs an "image" block.`);
    }
    if (seg.image) {
      const legacy = LEGACY_IMAGE_FIELDS.filter((f) => (seg.image as Record<string, unknown>)[f] !== undefined);
      for (const f of legacy) {
        issues.warn(at("image", f), `${label}: image.${f} was removed in schema 2.0 and is ignored${f === "motion" ? " (the crop engine moves the camera)" : f === "characters_present" ? " (use scene.characters_present)" : " (describe it in the scene or image.prompt)"}.`);
      }
      if (seg.image.crop_override) {
        const fields = seg.image.crop_override as Record<string, unknown>;
        const cap = typeof fields.max_crop === "number" ? fields.max_crop : null;
        if (cap !== null && cap > CROP_HARD_CAP) issues.error(at("image", "crop_override", "max_crop"), `${label}: max_crop is capped at ${CROP_HARD_CAP}.`);
      }
    }
    if (seg.type === "title_card" || seg.type === "infographic") {
      if (!seg.remotion) issues.error(at("remotion"), `${label}: ${seg.type} needs a "remotion" block.`);
    }
    if (seg.type === "reuse_image") {
      const ref = seg.image?.reuse_from_segment_id;
      if (!ref) {
        issues.error(at("image", "reuse_from_segment_id"), `${label}: reuse_image needs "image.reuse_from_segment_id".`);
      } else if (orderOf(ref) === null) {
        issues.error(at("image", "reuse_from_segment_id"), `${label}: segment "${ref}" does not exist.`);
      } else if ((orderOf(ref) ?? 0) >= seg.order) {
        issues.error(at("image", "reuse_from_segment_id"), `${label}: "${ref}" must come before this segment.`);
      } else if (!hasPicture(ref)) {
        issues.error(at("image", "reuse_from_segment_id"), `${label}: "${ref}" has no image to reuse.`);
      }
    }

    if (seg.remotion) {
      const props = seg.remotion.props;
      if (props.background === "image") {
        const bgRef = props.background_image_segment_id;
        if (bgRef) {
          if (orderOf(bgRef) === null) {
            issues.error(at("remotion", "props", "background_image_segment_id"), `${label}: segment "${bgRef}" does not exist.`);
          } else if (!hasPicture(bgRef)) {
            issues.error(at("remotion", "props", "background_image_segment_id"), `${label}: "${bgRef}" has no image.`);
          }
        } else if (!seg.image?.prompt.trim()) {
          issues.error(
            at("remotion", "props", "background"),
            `${label}: background "image" needs "image.prompt" on this segment or "remotion.props.background_image_segment_id".`,
          );
        }
      }
      props.items.forEach((item, ii) => {
        if (item.icon && !(KNOWN_ICONS as readonly string[]).includes(item.icon)) {
          issues.warn(at("remotion", "props", "items", ii, "icon"), `${label}: unknown icon "${item.icon}" will render as a generic circle.`);
        }
        if (item.icon_count !== null && item.icon_total !== null && item.icon_count > item.icon_total) {
          issues.error(at("remotion", "props", "items", ii, "icon_count"), `${label}: icon_count is larger than icon_total.`);
        }
      });
      const needsItems = seg.remotion.template === "supplies_card" || seg.remotion.template === "pictogram_chart";
      if (needsItems && props.items.length === 0) {
        issues.error(at("remotion", "props", "items"), `${label}: ${seg.remotion.template} needs at least one item.`);
      }
      if (!props.title && seg.remotion.template !== "custom") {
        issues.warn(at("remotion", "props", "title"), `${label}: card has no title.`);
      }
    }

    seg.sfx.forEach((cue, ci) => {
      const cuePath = at("sfx", ci);
      const prev = sfxIds.get(cue.id);
      if (prev) issues.error([...cuePath, "id"], `${label}: sfx id "${cue.id}" is already used in ${prev}.`);
      else sfxIds.set(cue.id, label);

      if (cue.placement === "at_phrase") {
        if (!cue.at_phrase?.trim()) {
          issues.warn([...cuePath, "at_phrase"], `${label}: placement "at_phrase" without "at_phrase"; falls back to segment_start.`);
        } else if (!phraseInText(cue.at_phrase, seg.narration)) {
          issues.warn([...cuePath, "at_phrase"], `${label}: "${cue.at_phrase}" is not in this segment's narration; falls back to segment_start.`);
        }
      }
      if (cue.continues_into_next && seg.order === segments.length) {
        issues.warn([...cuePath, "continues_into_next"], `${label}: last segment cannot continue into a next one.`);
      }
    });
  });

  doc.thumbnail.text_layers.forEach((layer, li) => {
    if (layer.position === "bottom_right") {
      issues.warn(P("thumbnail", "text_layers", li, "position"), "bottom_right is covered by YouTube's duration stamp.");
    }
  });

  const yt = doc.youtube;
  if (yt.title.length > YOUTUBE_TITLE_MAX) {
    issues.error(P("youtube", "title"), `Title is ${yt.title.length} characters; YouTube allows ${YOUTUBE_TITLE_MAX}.`);
  }
  if (hasForbiddenYoutubeChars(yt.title)) issues.error(P("youtube", "title"), 'Title must not contain "<" or ">".');
  if (hasForbiddenYoutubeChars(yt.description)) {
    issues.error(P("youtube", "description"), 'Description must not contain "<" or ">".');
  }
  const descBytes = utf8ByteLength(yt.description.replace(/\{\{(chapters|sfx_credits)\}\}/g, ""));
  if (descBytes > YOUTUBE_DESCRIPTION_MAX_BYTES) {
    issues.error(P("youtube", "description"), `Description is ${descBytes} bytes; YouTube allows ${YOUTUBE_DESCRIPTION_MAX_BYTES}.`);
  } else if (descBytes > YOUTUBE_DESCRIPTION_MAX_BYTES - 1200 && /\{\{(chapters|sfx_credits)\}\}/.test(yt.description)) {
    issues.warn(P("youtube", "description"), "Description is close to the 5000-byte limit; chapters/credits may not fit.");
  }
  const tagsLen = youtubeTagsLength(yt.tags);
  if (tagsLen > YOUTUBE_TAGS_MAX_CHARS) {
    issues.error(P("youtube", "tags"), `Tags total ${tagsLen} characters (commas and quotes counted); YouTube allows ${YOUTUBE_TAGS_MAX_CHARS}.`);
  }
  if (yt.visibility === "scheduled") {
    if (!yt.scheduled_publish_at) {
      issues.error(P("youtube", "scheduled_publish_at"), 'visibility "scheduled" requires "scheduled_publish_at".');
    } else if (new Date(yt.scheduled_publish_at).getTime() <= now.getTime()) {
      issues.error(P("youtube", "scheduled_publish_at"), "scheduled_publish_at must be in the future.");
    }
  } else if (yt.scheduled_publish_at) {
    issues.warn(P("youtube", "scheduled_publish_at"), `Ignored because visibility is "${yt.visibility}".`);
  }
  if (yt.description.includes("{{chapters}}") && !yt.chapters_from_segments) {
    issues.warn(P("youtube", "description"), "{{chapters}} is used but chapters_from_segments is false; it will be removed.");
  }

  const seenChapterSegs = new Set<string>();
  doc.chapters.forEach((ch, ci) => {
    if (orderOf(ch.segment_id) === null) {
      issues.error(P("chapters", ci, "segment_id"), `Chapter points at unknown segment "${ch.segment_id}".`);
    }
    if (seenChapterSegs.has(ch.segment_id)) {
      issues.error(P("chapters", ci, "segment_id"), `Two chapters start at "${ch.segment_id}".`);
    }
    seenChapterSegs.add(ch.segment_id);
  });
  if (yt.chapters_from_segments && doc.chapters.length > 0 && doc.chapters.length < 3) {
    issues.warn(P("chapters"), "YouTube needs at least 3 chapters; chapters will be left out of the description.");
  }

  const triggerIds = new Set<string>();
  doc.automation.bot_triggers.forEach((t, ti) => {
    if (triggerIds.has(t.trigger_id)) issues.error(P("automation", "bot_triggers", ti, "trigger_id"), `Duplicate trigger "${t.trigger_id}".`);
    triggerIds.add(t.trigger_id);
  });
  doc.automation.bot_triggers.forEach((t, ti) => {
    t.depends_on.forEach((dep, di) => {
      if (!triggerIds.has(dep)) issues.error(P("automation", "bot_triggers", ti, "depends_on", di), `Unknown trigger "${dep}".`);
    });
  });
}

function checkBibleOnly(bible: StoryBible, issues: IssueCollector, prefix: IssuePath) {
  checkStoryBible(bible, issues, prefix);
  checkCropPolicy(bible.defaults.crop_policy, issues, [...prefix, "defaults", "crop_policy"]);
  bible.style_bible.reference_assets.forEach((r, ri) => {
    let host = "";
    try {
      host = new URL(r.asset_url_or_path).hostname.toLowerCase();
    } catch {
      return;
    }
    if (/(^|\.)example\.(com|org|net)$/.test(host) || host === "localhost") {
      issues.error(
        [...prefix, "style_bible", "reference_assets", ri, "asset_url_or_path"],
        `Reference "${r.id}" points at a placeholder address (${host}). Use a real image URL or remove the reference.`,
      );
    }
  });
  if (!bible.defaults.voice.voice_id.trim()) {
    issues.warn([...prefix, "defaults", "voice", "voice_id"], "No voice_id; the worker's default FISH_VOICE_ID will be used.");
  }
}

/** Episode checks against a known story: additions, continuity, masters, resolved policies. */
function checkEpisodeWithStory(
  doc: EpisodeDoc,
  ctx: StoryContext,
  issues: IssueCollector,
  now: Date,
  prefix: IssuePath,
): { episode: Episode | null; continuity: ValidationResult["continuity"] } {
  const P = (...p: IssuePath) => [...prefix, ...p];
  if (doc.story_id !== ctx.bible.story_id) {
    issues.error(P("story_id"), `This episode belongs to story "${doc.story_id}", not "${ctx.bible.story_id}".`);
    return { episode: null, continuity: null };
  }
  checkBibleAdditions(ctx.bible, doc.bible_additions, issues, prefix);
  const effective = applyBibleAdditions(ctx.bible, doc.bible_additions);
  let episode: Episode;
  try {
    episode = resolveEpisode(ctx.bible, doc);
  } catch (e) {
    const zerr = e as z.ZodError;
    if (Array.isArray(zerr.issues)) zodIssues(zerr, issues, doc, P("overrides"));
    else issues.error(P("overrides"), `Overrides could not be applied: ${(e as Error).message}`);
    return { episode: null, continuity: null };
  }
  checkEpisodeDoc(doc, episode.voice, issues, now, prefix);
  checkCropPolicy(episode.crop_policy, issues, P("overrides", "crop_policy"));
  episode.segments.forEach((seg, i) => {
    if (!seg.image?.crop_override) return;
    try {
      checkCropPolicy(mergeCropPolicy(episode.crop_policy, seg.image.crop_override), issues, P("segments", i, "image", "crop_override"));
    } catch {
      issues.error(P("segments", i, "image", "crop_override"), `${seg.id}: crop_override is not a valid crop policy.`);
    }
  });

  const start = startSnapshotFor(ctx.state, effective, doc.series.episode_number);
  const continuity = checkContinuity(effective, doc, start, issues, prefix);
  episode.story.start_state = { locations: start.locations, world: start.world, outfits: start.outfits };

  if (ctx.approvedMasters && ctx.mastersGate !== false) {
    const missing = [
      ...continuity.usedViews.map(masterKeyForView),
      ...continuity.usedOutfits.map(masterKeyForOutfit),
    ].filter((k) => !ctx.approvedMasters!.has(k));
    if (missing.length) {
      issues.warn(
        P("segments"),
        `${missing.length} master image(s) are not approved yet (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}). Image generation waits for them.`,
      );
    }
  }
  return { episode, continuity: { ...continuity, start } };
}

function runtimeWarnings(estimate: EpisodeEstimate, issues: IssueCollector, prefix: IssuePath) {
  if (estimate.total_seconds < MIN_RUNTIME_WARNING_SEC) {
    issues.warn([...prefix, "segments"], `Estimated runtime ${Math.round(estimate.total_seconds / 60)} min is under 5 minutes.`);
  } else if (estimate.total_seconds > MAX_RUNTIME_WARNING_SEC) {
    issues.warn([...prefix, "segments"], `Estimated runtime ${Math.round(estimate.total_seconds / 60)} min is over 20 minutes.`);
  }
}

export function detectDocType(raw: unknown): { doc_type: DocType | null; legacy: boolean; story_id: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { doc_type: null, legacy: false, story_id: null };
  const o = raw as Record<string, unknown>;
  const legacy = o.schema_version === "1.0" || (!("doc_type" in o) && "style_bible" in o && "segments" in o);
  const t = o.doc_type;
  const doc_type = t === "story_bible" || t === "episode" || t === "bundle" ? t : null;
  const sid =
    typeof o.story_id === "string"
      ? o.story_id
      : typeof (o.story_bible as Record<string, unknown> | undefined)?.story_id === "string"
        ? ((o.story_bible as Record<string, unknown>).story_id as string)
        : null;
  return { doc_type, legacy, story_id: sid };
}

function empty(doc_type: DocType | null, issues: IssueCollector): ValidationResult {
  return {
    ok: false,
    doc_type,
    story: null,
    episode_doc: null,
    episode: null,
    needs_story: null,
    continuity: null,
    errors: issues.errors,
    warnings: issues.warnings,
    estimate: null,
  };
}

export interface ValidateOptions {
  now?: Date;
  locate?: Locator | null;
  /** For episode documents: the stored story (with its state and masters). */
  story?: StoryContext | null;
}

/** Validate any v2 document. Episodes are fully checked only when their story is known (bundle or `story`). */
export function validateDocument(raw: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues = new IssueCollector(options.locate ?? null);
  const now = options.now ?? new Date();
  const { doc_type, legacy } = detectDocType(raw);
  if (legacy) {
    issues.error(
      ["schema_version"],
      `This is a schema 1.0 episode. Paste schema ${SCHEMA_VERSION} documents, or convert it with "Convert v1" (it becomes a bundle).`,
    );
    return empty(null, issues);
  }
  if (!doc_type) {
    issues.error(["doc_type"], '"doc_type" must be "story_bible", "episode" or "bundle".');
    return empty(null, issues);
  }

  if (doc_type === "story_bible") {
    const parsed = StoryBibleSchema.safeParse(raw);
    if (!parsed.success) {
      zodIssues(parsed.error, issues, raw);
      return empty(doc_type, issues);
    }
    checkBibleOnly(parsed.data, issues, []);
    const ok = issues.errors.length === 0;
    return { ...empty(doc_type, issues), ok, story: parsed.data };
  }

  if (doc_type === "bundle") {
    const parsed = BundleSchema.safeParse(raw);
    if (!parsed.success) {
      zodIssues(parsed.error, issues, raw);
      return empty(doc_type, issues);
    }
    const { story_bible, episode: doc } = parsed.data;
    checkBibleOnly(story_bible, issues, ["story_bible"]);
    const ctx: StoryContext = options.story?.bible.story_id === story_bible.story_id
      ? { ...options.story, bible: story_bible }
      : { bible: story_bible, state: null };
    const { episode, continuity } = checkEpisodeWithStory(doc, ctx, issues, now, ["episode"]);
    const estimate = episode ? estimateEpisode(episode) : null;
    if (estimate) runtimeWarnings(estimate, issues, ["episode"]);
    const ok = issues.errors.length === 0;
    return {
      ...empty(doc_type, issues),
      ok,
      story: story_bible,
      episode_doc: doc,
      episode: ok ? episode : null,
      continuity,
      estimate,
    };
  }

  const parsed = EpisodeDocSchema.safeParse(raw);
  if (!parsed.success) {
    zodIssues(parsed.error, issues, raw);
    return empty(doc_type, issues);
  }
  const doc = parsed.data;
  if (!options.story) {
    const voice = VoiceSchema.parse({ ...(doc.overrides.voice ?? {}) });
    checkEpisodeDoc(doc, voice, issues, now, []);
    const estimate = estimateEpisode({ ...doc, voice, render: { intro_sec: 0, outro_sec: 0 } });
    runtimeWarnings(estimate, issues, []);
    return {
      ...empty(doc_type, issues),
      ok: false,
      episode_doc: doc,
      needs_story: doc.story_id,
      estimate,
    };
  }
  const { episode, continuity } = checkEpisodeWithStory(doc, options.story, issues, now, []);
  const estimate = episode ? estimateEpisode(episode) : null;
  if (estimate) runtimeWarnings(estimate, issues, []);
  const ok = issues.errors.length === 0;
  return { ...empty(doc_type, issues), ok, episode_doc: doc, episode: ok ? episode : null, continuity, estimate };
}

export function parseJsonText(text: string): { raw: unknown; errors: ValidationIssue[] } {
  const parseErrors: ParseError[] = [];
  const raw = parse(text, parseErrors, { disallowComments: true, allowTrailingComma: false });
  if (parseErrors.length === 0 && raw !== undefined) return { raw, errors: [] };
  const starts = lineStarts(text);
  const list = parseErrors.length ? parseErrors : [{ error: 1 as ParseError["error"], offset: 0, length: 0 }];
  return {
    raw: undefined,
    errors: list.map((e) => {
      const loc = offsetToLineColumn(starts, e.offset);
      const code = printParseErrorCode(e.error);
      const hint = code === "InvalidCommentToken" ? " (comments are not allowed in strict JSON)" : "";
      return {
        level: "error" as const,
        path: [],
        path_text: "(syntax)",
        message: `Invalid JSON: ${code}${hint}`,
        line: loc.line,
        column: loc.column,
      };
    }),
  };
}

export function validateText(text: string, options: Omit<ValidateOptions, "locate"> = {}): ValidationResult {
  const { raw, errors } = parseJsonText(text);
  if (errors.length) return { ...empty(null, new IssueCollector(null)), errors };
  return validateDocument(raw, { ...options, locate: makeLocator(text) });
}
