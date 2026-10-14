import { YOUTUBE_DESCRIPTION_MAX_BYTES } from "@/lib/episode/constants";
import type { Episode } from "@/lib/episode/schema";
import { roleChapters } from "@/lib/episode/structure";
import { chapterProblem, chaptersText, utf8ByteLength, type ChapterInput } from "@/lib/episode/youtube";

export interface SfxCredit {
  title: string;
  author: string;
  license: string;
  license_url: string;
  source_url: string;
  provider: string;
  attribution_required: boolean;
}

export interface FinalDescription {
  description: string;
  /** The description with `{{series_nav}}` still in place, re-rendered when a neighbouring episode is published. */
  template: string;
  chapters: ChapterInput[];
  chapters_text: string;
  chapters_problem: string | null;
  credits_text: string;
  bytes: number;
  error: string | null;
}

/** Explicit `chapters` win; without them, chapters come from runs of segment roles (cold open, recap, …). */
export function buildChapters(ep: Episode, segmentStarts: Record<string, number>, durationSec = Infinity): ChapterInput[] {
  if (!ep.chapters.length) return roleChapters(ep.segments, segmentStarts, durationSec, ep.series.episode_title_short);
  const chapters = ep.chapters
    .map((c) => ({ title: c.title.trim(), start_seconds: segmentStarts[c.segment_id] ?? Number.NaN }))
    .filter((c) => Number.isFinite(c.start_seconds))
    .sort((a, b) => a.start_seconds - b.start_seconds);
  // YouTube ignores a chapter list that does not begin at 0:00.
  if (chapters.length && chapters[0].start_seconds > 0) {
    if (chapters[0].start_seconds < 10) chapters[0] = { ...chapters[0], start_seconds: 0 };
    else chapters.unshift({ title: "Intro", start_seconds: 0 });
  }
  return chapters;
}

const LICENSE_NAMES: Record<string, string> = {
  cc0: "CC0 1.0",
  pdm: "Public Domain Mark 1.0",
  by: "CC BY",
  "by-sa": "CC BY-SA",
  "by-nd": "CC BY-ND",
};

export function licenseName(code: string, url = ""): string {
  const base = LICENSE_NAMES[code.toLowerCase()];
  if (!base) return code;
  const version = /\/(\d\.\d)\/?$/.exec(url)?.[1];
  return version && base.startsWith("CC BY") ? `${base} ${version}` : base;
}

export function creditsText(credits: SfxCredit[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of credits) {
    if (!c.attribution_required) continue;
    const key = `${c.provider}:${c.source_url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const by = c.author ? ` by ${c.author}` : "";
    const name = licenseName(c.license, c.license_url);
    const lic = c.license_url ? `${name} (${c.license_url})` : name;
    lines.push(`"${c.title || "Untitled"}"${by}, ${c.source_url}, licensed under ${lic}`);
  }
  return lines.length ? `Sound effects:\n${lines.join("\n")}` : "";
}

export interface NavEpisode {
  number: number;
  title: string;
  url: string | null;
}

/** What `{{series_nav}}` renders: links to the neighbouring episodes once their URLs are known. */
export interface SeriesNav {
  episode_number: number;
  total_planned: number | null;
  previous: NavEpisode | null;
  next: NavEpisode | null;
}

export const SERIES_NAV = "{{series_nav}}";

export function seriesNavText(nav: SeriesNav): string {
  const lines = [nav.total_planned ? `Episode ${nav.episode_number} of ${nav.total_planned}` : `Episode ${nav.episode_number}`];
  if (nav.previous?.url) lines.push(`Previous: Ep ${nav.previous.number} - ${nav.previous.title}: ${nav.previous.url}`);
  if (nav.next?.url) lines.push(`Next: Ep ${nav.next.number} - ${nav.next.title}: ${nav.next.url}`);
  return lines.join("\n");
}

function sizeError(bytes: number): string | null {
  return bytes > YOUTUBE_DESCRIPTION_MAX_BYTES
    ? `Final description is ${bytes} bytes after adding chapters, credits and series links; YouTube allows ${YOUTUBE_DESCRIPTION_MAX_BYTES}. Shorten youtube.description.`
    : null;
}

/** Fill `{{series_nav}}` in a stored template. Without the placeholder the template is returned unchanged. */
export function applySeriesNav(template: string, nav: SeriesNav | null): { description: string; bytes: number; error: string | null } {
  const description = template.includes(SERIES_NAV)
    ? template.replaceAll(SERIES_NAV, nav ? seriesNavText(nav) : "").replace(/\n{3,}/g, "\n\n").trim()
    : template;
  const bytes = utf8ByteLength(description);
  return { description, bytes, error: sizeError(bytes) };
}

export function finalizeDescription(
  ep: Episode,
  segmentStarts: Record<string, number>,
  durationSec: number,
  credits: SfxCredit[],
  nav: SeriesNav | null = null,
): FinalDescription {
  const chapters = ep.youtube.chapters_from_segments ? buildChapters(ep, segmentStarts, durationSec) : [];
  const problem = chapters.length ? chapterProblem(chapters, durationSec) : null;
  const usableChapters = problem ? [] : chapters;
  const chText = chaptersText(usableChapters);
  const crText = creditsText(credits);

  let description = ep.youtube.description;
  description = description.includes("{{chapters}}")
    ? description.replace("{{chapters}}", chText)
    : chText
      ? `${description.trimEnd()}\n\n${chText}`
      : description;
  if (description.includes("{{sfx_credits}}")) description = description.replace("{{sfx_credits}}", crText);
  else if (crText) description = `${description.trimEnd()}\n\n${crText}`;
  const template = description.replace(/\n{3,}/g, "\n\n").trim();
  const rendered = applySeriesNav(template, nav);
  return {
    description: rendered.description,
    template,
    chapters: usableChapters,
    chapters_text: chText,
    chapters_problem: problem,
    credits_text: crText,
    bytes: rendered.bytes,
    error: rendered.error,
  };
}
