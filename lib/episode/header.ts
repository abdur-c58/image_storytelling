/**
 * The episode header (schema 2.3): `story_id`, `story_title`, `episode_number`, `episode_title`, `is_finale` at the
 * top of an episode file, so the site can file it into the right story folder. Older documents carry the number,
 * short title and finale flag in `series`. Both forms are accepted; this fills each from the other before parsing.
 */

import { schemaAtLeast } from "./constants";

export interface HeaderIssue {
  level: "error" | "warning";
  path: (string | number)[];
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** Returns a copy of `raw` with both header forms filled in, plus any conflicts between them. */
export function normalizeEpisodeHeader(raw: unknown, prefix: (string | number)[] = []): { raw: unknown; issues: HeaderIssue[] } {
  if (!isObj(raw)) return { raw, issues: [] };
  const issues: HeaderIssue[] = [];
  const doc: Obj = structuredClone(raw);
  const series: Obj = isObj(doc.series) ? doc.series : {};
  const at = (...p: (string | number)[]) => [...prefix, ...p];

  if (typeof doc.schema_version === "string" && schemaAtLeast(doc.schema_version, "2.3")) {
    if (doc.episode_number === undefined) {
      issues.push({ level: "error", path: at("episode_number"), message: '"episode_number" is required in the 2.3 episode header.' });
    }
    if (doc.episode_title === undefined) {
      issues.push({ level: "error", path: at("episode_title"), message: '"episode_title" is required in the 2.3 episode header.' });
    }
  }

  if (doc.episode_number !== undefined && series.episode_number !== undefined && doc.episode_number !== series.episode_number) {
    issues.push({
      level: "error",
      path: at("episode_number"),
      message: `episode_number ${String(doc.episode_number)} disagrees with series.episode_number ${String(series.episode_number)}. Remove one of them.`,
    });
  }
  if (doc.is_finale !== undefined && series.is_finale !== undefined && doc.is_finale !== series.is_finale) {
    issues.push({ level: "error", path: at("is_finale"), message: "is_finale disagrees with series.is_finale. Remove one of them." });
  }
  if (doc.episode_number === undefined && series.episode_number !== undefined) doc.episode_number = series.episode_number;
  if (series.episode_number === undefined && doc.episode_number !== undefined) series.episode_number = doc.episode_number;
  if (doc.is_finale === undefined && series.is_finale !== undefined) doc.is_finale = series.is_finale;
  if (series.is_finale === undefined && doc.is_finale !== undefined) series.is_finale = doc.is_finale;
  if (!nonEmpty(series.episode_title_short) && nonEmpty(doc.episode_title)) series.episode_title_short = doc.episode_title;
  if (doc.episode_title === undefined && nonEmpty(series.episode_title_short)) doc.episode_title = series.episode_title_short;

  const youtube: Obj = isObj(doc.youtube) ? doc.youtube : {};
  if (!nonEmpty(youtube.title) && nonEmpty(doc.episode_title)) {
    youtube.title = doc.episode_title;
    doc.youtube = youtube;
  }
  doc.series = series;
  return { raw: doc, issues };
}

/** The bundle form: the header lives in `episode`. */
export function normalizeBundleHeader(raw: unknown): { raw: unknown; issues: HeaderIssue[] } {
  if (!isObj(raw) || !isObj(raw.episode)) return { raw, issues: [] };
  const inner = normalizeEpisodeHeader(raw.episode, ["episode"]);
  return { raw: { ...raw, episode: inner.raw }, issues: inner.issues };
}

/** Header facts read straight from a raw document (before validation), for routing and previews. */
export interface HeaderInfo {
  story_id: string | null;
  story_title: string | null;
  episode_number: number | null;
  episode_title: string | null;
}

export function readHeader(raw: unknown): HeaderInfo {
  const none: HeaderInfo = { story_id: null, story_title: null, episode_number: null, episode_title: null };
  if (!isObj(raw)) return none;
  const ep = raw.doc_type === "bundle" ? (isObj(raw.episode) ? raw.episode : null) : raw.doc_type === "episode" ? raw : null;
  const bible = raw.doc_type === "bundle" ? (isObj(raw.story_bible) ? raw.story_bible : null) : raw.doc_type === "story_bible" ? raw : null;
  const n = normalizeEpisodeHeader(ep ?? {}).raw as Obj;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    story_id: str(ep?.story_id) ?? str(bible?.story_id),
    story_title: str(bible?.story_title) ?? str(ep?.story_title),
    episode_number: ep && typeof n.episode_number === "number" ? n.episode_number : null,
    episode_title: ep ? str(n.episode_title) : null,
  };
}
