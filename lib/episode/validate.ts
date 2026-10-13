import { findNodeAtLocation, parse, parseTree, printParseErrorCode, type Node, type ParseError } from "jsonc-parser";
import type { z } from "zod";
import {
  KNOWN_ICONS,
  MAX_RUNTIME_WARNING_SEC,
  MAX_SEGMENT_WORDS_WARNING,
  MIN_RUNTIME_WARNING_SEC,
  SHOT_TYPES,
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_TAGS_MAX_CHARS,
  YOUTUBE_TITLE_MAX,
} from "./constants";
import { countWords, estimateEpisode, type EpisodeEstimate } from "./estimate";
import { EpisodeObjectSchema, type Episode } from "./schema";
import { phraseInText } from "./text";
import { hasForbiddenYoutubeChars, utf8ByteLength, youtubeTagsLength } from "./youtube";

export type IssuePath = (string | number)[];

export interface ValidationIssue {
  level: "error" | "warning";
  path: IssuePath;
  path_text: string;
  message: string;
  line: number | null;
  column: number | null;
}

export interface ValidationResult {
  ok: boolean;
  episode: Episode | null;
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

function zodIssues(error: z.ZodError, issues: IssueCollector, raw: unknown) {
  for (const issue of error.issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    let message = issue.message;
    // Name the segment so the message is readable without counting array indices.
    if (path[0] === "segments" && typeof path[1] === "number") {
      const seg = (raw as { segments?: Array<{ id?: unknown }> })?.segments?.[path[1]];
      if (seg && typeof seg.id === "string") message = `${seg.id}: ${message}`;
    }
    issues.error(path, message);
  }
}

function crossFieldChecks(ep: Episode, issues: IssueCollector, now: Date) {
  const segIndex = new Map<string, number>();
  const sfxIds = new Map<string, string>();
  const characterIds = new Set(ep.style_bible.characters.map((c) => c.id));
  const referenceIds = new Set(ep.style_bible.reference_assets.map((r) => r.id));

  // Unique ids and contiguous order.
  ep.segments.forEach((seg, i) => {
    if (segIndex.has(seg.id)) issues.error(["segments", i, "id"], `Duplicate segment id "${seg.id}".`);
    else segIndex.set(seg.id, i);
  });
  const orders = ep.segments.map((s) => s.order).sort((a, b) => a - b);
  orders.forEach((order, i) => {
    if (order !== i + 1) {
      const idx = ep.segments.findIndex((s) => s.order === order);
      issues.error(
        ["segments", idx, "order"],
        `Segment "order" values must be contiguous from 1 with no duplicates (expected ${i + 1}, found ${order}).`,
      );
    }
  });
  const orderOf = (id: string) => {
    const idx = segIndex.get(id);
    return idx === undefined ? null : ep.segments[idx].order;
  };
  const hasPicture = (id: string) => {
    const idx = segIndex.get(id);
    if (idx === undefined) return false;
    const s = ep.segments[idx];
    return (
      s.type === "illustration" ||
      s.type === "reuse_image" ||
      (s.remotion?.props.background === "image" && !!s.image?.prompt.trim())
    );
  };

  ep.style_bible.reference_assets.forEach((r, ri) => {
    let host = "";
    try {
      host = new URL(r.asset_url_or_path).hostname.toLowerCase();
    } catch {
      return;
    }
    if (/(^|\.)example\.(com|org|net)$/.test(host) || host === "localhost") {
      issues.error(
        ["style_bible", "reference_assets", ri, "asset_url_or_path"],
        `Reference "${r.id}" points at a placeholder address (${host}). Use a real image URL or remove the reference.`,
      );
    }
  });

  ep.style_bible.characters.forEach((c, ci) => {
    c.reference_image_ids.forEach((rid, ri) => {
      if (!referenceIds.has(rid)) {
        issues.error(
          ["style_bible", "characters", ci, "reference_image_ids", ri],
          `Unknown reference asset "${rid}". Add it to style_bible.reference_assets.`,
        );
      }
    });
  });

  ep.segments.forEach((seg, i) => {
    const at = (...rest: (string | number)[]) => ["segments", i, ...rest];
    const label = seg.id;
    const words = countWords(seg.narration);

    if (!seg.silent && !seg.narration.trim()) {
      issues.error(at("narration"), `${label}: "narration" is required unless "silent" is true.`);
    }
    if (seg.silent && seg.narration.trim()) {
      issues.warn(at("narration"), `${label}: segment is silent, so its narration will not be spoken.`);
    }
    if (words > MAX_SEGMENT_WORDS_WARNING) {
      issues.warn(
        at("narration"),
        `${label}: ${words} words is long for one image (over ${MAX_SEGMENT_WORDS_WARNING}). Consider splitting.`,
      );
    }

    if (seg.type === "illustration") {
      if (!seg.image?.prompt.trim()) issues.error(at("image", "prompt"), `${label}: illustration needs "image.prompt".`);
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

    if (seg.image) {
      seg.image.characters_present.forEach((cid, ci) => {
        if (!characterIds.has(cid)) {
          issues.error(at("image", "characters_present", ci), `${label}: unknown character "${cid}".`);
        }
      });
      const shot = seg.image.shot_type.trim();
      if (shot && !(SHOT_TYPES as readonly string[]).includes(shot)) {
        issues.warn(at("image", "shot_type"), `${label}: unusual shot_type "${shot}" (known: ${SHOT_TYPES.join(", ")}).`);
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
          issues.warn(
            at("remotion", "props", "items", ii, "icon"),
            `${label}: unknown icon "${item.icon}" will render as a generic circle.`,
          );
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
          issues.warn(
            [...cuePath, "at_phrase"],
            `${label}: "${cue.at_phrase}" is not in this segment's narration; falls back to segment_start.`,
          );
        }
      }
      if (cue.continues_into_next && seg.order === ep.segments.length) {
        issues.warn([...cuePath, "continues_into_next"], `${label}: last segment cannot continue into a next one.`);
      }
    });
  });

  // Thumbnail
  ep.thumbnail.characters_present.forEach((cid, ci) => {
    if (!characterIds.has(cid)) issues.error(["thumbnail", "characters_present", ci], `Unknown character "${cid}".`);
  });
  ep.thumbnail.text_layers.forEach((layer, li) => {
    if (layer.position === "bottom_right") {
      issues.warn(["thumbnail", "text_layers", li, "position"], "bottom_right is covered by YouTube's duration stamp.");
    }
  });

  // YouTube
  const yt = ep.youtube;
  if (yt.title.length > YOUTUBE_TITLE_MAX) {
    issues.error(["youtube", "title"], `Title is ${yt.title.length} characters; YouTube allows ${YOUTUBE_TITLE_MAX}.`);
  }
  if (hasForbiddenYoutubeChars(yt.title)) issues.error(["youtube", "title"], 'Title must not contain "<" or ">".');
  if (hasForbiddenYoutubeChars(yt.description)) {
    issues.error(["youtube", "description"], 'Description must not contain "<" or ">".');
  }
  const descBytes = utf8ByteLength(yt.description.replace(/\{\{(chapters|sfx_credits)\}\}/g, ""));
  if (descBytes > YOUTUBE_DESCRIPTION_MAX_BYTES) {
    issues.error(["youtube", "description"], `Description is ${descBytes} bytes; YouTube allows ${YOUTUBE_DESCRIPTION_MAX_BYTES}.`);
  } else if (descBytes > YOUTUBE_DESCRIPTION_MAX_BYTES - 1200 && /\{\{(chapters|sfx_credits)\}\}/.test(yt.description)) {
    issues.warn(["youtube", "description"], "Description is close to the 5000-byte limit; chapters/credits may not fit.");
  }
  const tagsLen = youtubeTagsLength(yt.tags);
  if (tagsLen > YOUTUBE_TAGS_MAX_CHARS) {
    issues.error(["youtube", "tags"], `Tags total ${tagsLen} characters (commas and quotes counted); YouTube allows ${YOUTUBE_TAGS_MAX_CHARS}.`);
  }
  if (yt.visibility === "scheduled") {
    if (!yt.scheduled_publish_at) {
      issues.error(["youtube", "scheduled_publish_at"], 'visibility "scheduled" requires "scheduled_publish_at".');
    } else if (new Date(yt.scheduled_publish_at).getTime() <= now.getTime()) {
      issues.error(["youtube", "scheduled_publish_at"], "scheduled_publish_at must be in the future.");
    }
  } else if (yt.scheduled_publish_at) {
    issues.warn(["youtube", "scheduled_publish_at"], `Ignored because visibility is "${yt.visibility}".`);
  }
  if (yt.description.includes("{{chapters}}") && !yt.chapters_from_segments) {
    issues.warn(["youtube", "description"], "{{chapters}} is used but chapters_from_segments is false; it will be removed.");
  }

  // Chapters
  const seenChapterSegs = new Set<string>();
  ep.chapters.forEach((ch, ci) => {
    if (orderOf(ch.segment_id) === null) {
      issues.error(["chapters", ci, "segment_id"], `Chapter points at unknown segment "${ch.segment_id}".`);
    }
    if (seenChapterSegs.has(ch.segment_id)) {
      issues.error(["chapters", ci, "segment_id"], `Two chapters start at "${ch.segment_id}".`);
    }
    seenChapterSegs.add(ch.segment_id);
  });
  if (yt.chapters_from_segments && ep.chapters.length > 0 && ep.chapters.length < 3) {
    issues.warn(["chapters"], "YouTube needs at least 3 chapters; chapters will be left out of the description.");
  }

  // Automation
  const triggerIds = new Set<string>();
  ep.automation.bot_triggers.forEach((t, ti) => {
    if (triggerIds.has(t.trigger_id)) issues.error(["automation", "bot_triggers", ti, "trigger_id"], `Duplicate trigger "${t.trigger_id}".`);
    triggerIds.add(t.trigger_id);
  });
  ep.automation.bot_triggers.forEach((t, ti) => {
    t.depends_on.forEach((dep, di) => {
      if (!triggerIds.has(dep)) {
        issues.error(["automation", "bot_triggers", ti, "depends_on", di], `Unknown trigger "${dep}".`);
      }
    });
  });

  if (!ep.voice.voice_id.trim()) {
    issues.warn(["voice", "voice_id"], "No voice_id; the worker's default FISH_VOICE_ID will be used.");
  }
}

export function validateEpisodeObject(raw: unknown, options: { now?: Date; locate?: Locator | null } = {}): ValidationResult {
  const issues = new IssueCollector(options.locate ?? null);
  const parsed = EpisodeObjectSchema.safeParse(raw);
  if (!parsed.success) {
    zodIssues(parsed.error, issues, raw);
    return { ok: false, episode: null, errors: issues.errors, warnings: issues.warnings, estimate: null };
  }
  const episode = parsed.data;
  crossFieldChecks(episode, issues, options.now ?? new Date());
  const estimate = estimateEpisode(episode);
  if (estimate.total_seconds < MIN_RUNTIME_WARNING_SEC) {
    issues.warn(["segments"], `Estimated runtime ${Math.round(estimate.total_seconds / 60)} min is under 5 minutes.`);
  } else if (estimate.total_seconds > MAX_RUNTIME_WARNING_SEC) {
    issues.warn(["segments"], `Estimated runtime ${Math.round(estimate.total_seconds / 60)} min is over 20 minutes.`);
  }
  const ok = issues.errors.length === 0;
  return { ok, episode: ok ? episode : null, errors: issues.errors, warnings: issues.warnings, estimate };
}

export function validateEpisodeText(text: string, options: { now?: Date } = {}): ValidationResult {
  const parseErrors: ParseError[] = [];
  const raw = parse(text, parseErrors, { disallowComments: true, allowTrailingComma: false });
  if (parseErrors.length > 0 || raw === undefined) {
    const starts = lineStarts(text);
    const errors: ValidationIssue[] = (parseErrors.length ? parseErrors : [{ error: 1 as ParseError["error"], offset: 0, length: 0 }]).map(
      (e) => {
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
      },
    );
    return { ok: false, episode: null, errors, warnings: [], estimate: null };
  }
  return validateEpisodeObject(raw, { now: options.now, locate: makeLocator(text) });
}
