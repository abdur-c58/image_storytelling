import { NAME_CARD_TEMPLATE, NARRATOR, PRONOUN_NAMES, ROLE_CHAPTER_TITLES } from "./constants";
import type { IssuePath, IssueSink } from "./continuity";
import { estimateSegmentSeconds } from "./estimate";
import { segmentLines } from "./lines";
import type { Episode, EpisodeDoc, Identification, Scene, SegmentRole, StoryBible, Structure } from "./schema";

type Seg = EpisodeDoc["segments"][number];
type Pov = StoryBible["narrator"]["pov"];

const byOrder = (segments: Seg[]) => [...segments].sort((a, b) => a.order - b.order);

// ── Viewer identification ───────────────────────────────────────────────

export type EffectiveIdentification = Identification & { pov_character_id: string };

/** The bible's identification block with its POV character filled in, or null when there is none. */
export function identificationOf(bible: Pick<StoryBible, "narrator">): EffectiveIdentification | null {
  const idn = bible.narrator.identification;
  const pov = idn?.pov_character_id ?? bible.narrator.pov_character_id;
  return idn && pov ? { ...idn, pov_character_id: pov } : null;
}

export function checkIdentificationBible(bible: StoryBible, issues: IssueSink, at: (...p: IssuePath) => IssuePath) {
  const idn = bible.narrator.identification;
  if (!idn) return;
  const ip = (...p: IssuePath) => at("narrator", "identification", ...p);
  const pov = idn.pov_character_id ?? bible.narrator.pov_character_id;
  if (!pov) {
    issues.error(ip("pov_character_id"), "identification needs a pov_character_id (here or in narrator.pov_character_id).");
    return;
  }
  if (idn.pov_character_id && bible.narrator.pov_character_id && idn.pov_character_id !== bible.narrator.pov_character_id) {
    issues.error(ip("pov_character_id"), `identification names "${idn.pov_character_id}" but narrator.pov_character_id is "${bible.narrator.pov_character_id}".`);
  }
  if (!bible.characters.some((c) => c.id === pov)) issues.error(ip("pov_character_id"), `Unknown character "${pov}".`);
  if (bible.narrator.pov === "third_person") {
    issues.warn(ip(), "identification is meant for second-person stories (the viewer is the POV character); this story is third person.");
  }
  if (idn.name_card?.enabled && !idn.name_card.text.trim()) {
    issues.warn(ip("name_card", "text"), "name_card.text is empty; name card segments must then set remotion.props.text.");
  }
}

export type PovStatus = "on_screen" | "missing" | "exception" | "ineligible";

export interface PovSegment {
  segment_id: string;
  order: number;
  status: PovStatus;
  reason: string | null;
}

export interface IdentificationReport {
  pov_character_id: string;
  /** Present-time illustration / reuse_image segments, minus exceptions. */
  eligible: number;
  on_screen: number;
  /** null when no segment is eligible. */
  ratio: number | null;
  min: number;
  hard_min: number;
  /** false: no identification block, so the ratio is shown but not enforced. */
  enforced: boolean;
  segments: PovSegment[];
}

/** The scene a segment shows: its own, or for reuse_image without one, the scene of the segment it reuses. */
export function effectiveScene(seg: Seg, byId: Map<string, Seg>): Scene | null {
  let current: Seg | undefined = seg;
  for (let hops = 0; current && hops < 20; hops++) {
    if (current.scene) return current.scene;
    if (current.type !== "reuse_image" || !current.image?.reuse_from_segment_id) return null;
    current = byId.get(current.image.reuse_from_segment_id);
  }
  return null;
}

export function onScreenReport(
  segments: Seg[],
  povId: string,
  thresholds: { min: number; hard_min: number; enforced: boolean },
): IdentificationReport {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const rows: PovSegment[] = byOrder(segments).map((seg) => {
    const row = { segment_id: seg.id, order: seg.order, reason: null as string | null };
    const scene = seg.type === "illustration" || seg.type === "reuse_image" ? effectiveScene(seg, byId) : null;
    if (!scene || scene.timeframe !== "present") return { ...row, status: "ineligible" as const };
    const inFrame = scene.characters_present.some((c) => c.character_id === povId);
    const reason = seg.scene?.pov_exception_reason ?? scene.pov_exception_reason;
    if (reason && !inFrame) return { ...row, status: "exception" as const, reason };
    return { ...row, status: inFrame ? ("on_screen" as const) : ("missing" as const) };
  });
  const eligible = rows.filter((r) => r.status === "on_screen" || r.status === "missing").length;
  const on = rows.filter((r) => r.status === "on_screen").length;
  return {
    pov_character_id: povId,
    eligible,
    on_screen: on,
    ratio: eligible ? on / eligible : null,
    min: thresholds.min,
    hard_min: thresholds.hard_min,
    enforced: thresholds.enforced,
    segments: rows,
  };
}

/** The on-screen report for a resolved episode (project page), or null when the story has no POV character to count. */
export function episodePovReport(ep: Pick<Episode, "segments" | "story">): IdentificationReport | null {
  const narrator = ep.story.narrator;
  const idn = identificationOf({ narrator });
  const povId = idn?.pov_character_id ?? (narrator.pov === "second_person" ? narrator.pov_character_id : null);
  if (!povId) return null;
  return onScreenReport(ep.segments, povId, {
    min: idn?.min_on_screen_ratio ?? 0.8,
    hard_min: idn?.hard_min_on_screen_ratio ?? 0.5,
    enforced: !!idn,
  });
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/**
 * Episode checks for viewer identification: on-screen ratio and the name card. Returns the ratio report for the
 * validation panel (also, unenforced, for second-person stories without an identification block).
 */
export function checkIdentificationEpisode(
  bible: StoryBible,
  doc: EpisodeDoc,
  issues: IssueSink,
  prefix: IssuePath = [],
): IdentificationReport | null {
  const idn = identificationOf(bible);
  const segIndex = new Map(doc.segments.map((s, i) => [s.id, i]));
  const at = (id: string, ...p: IssuePath) => [...prefix, "segments", segIndex.get(id) ?? 0, ...p];

  doc.segments.forEach((seg, i) => {
    if (seg.remotion?.template !== NAME_CARD_TEMPLATE) return;
    const sp = [...prefix, "segments", i];
    if (!seg.silent && segmentLines(seg).length) issues.warn([...sp, "silent"], `${seg.id}: a name card is a silent hold; set "silent": true and move the words to the next segment.`);
    if (!seg.remotion.props.text?.trim() && !idn?.name_card?.text.trim()) {
      issues.error([...sp, "remotion", "props", "text"], `${seg.id}: name_card needs remotion.props.text (or narrator.identification.name_card.text).`);
    }
    const cid = seg.remotion.props.character_id;
    if (cid && !bible.characters.some((c) => c.id === cid)) issues.error([...sp, "remotion", "props", "character_id"], `${seg.id}: unknown character "${cid}".`);
  });

  const povId = idn?.pov_character_id ?? (bible.narrator.pov === "second_person" ? bible.narrator.pov_character_id : null);
  if (!povId) return null;
  const report = onScreenReport(doc.segments, povId, {
    min: idn?.min_on_screen_ratio ?? 0.8,
    hard_min: idn?.hard_min_on_screen_ratio ?? 0.5,
    enforced: !!idn,
  });
  if (!idn) return report;

  for (const row of report.segments) {
    const seg = doc.segments[segIndex.get(row.segment_id)!];
    if (seg.scene?.pov_exception_reason && row.status === "on_screen") {
      issues.warn(at(row.segment_id, "scene", "pov_exception_reason"), `${row.segment_id}: pov_exception_reason is set, but ${povId} is in the picture; remove it.`);
    }
  }
  if (report.ratio !== null) {
    const missing = report.segments.filter((r) => r.status === "missing").map((r) => r.segment_id);
    const detail = `${povId} is on screen in ${report.on_screen}/${report.eligible} present-day pictures (${pct(report.ratio)})`;
    const list = missing.length ? ` Missing from: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}.` : "";
    const fix = " Add them to scene.characters_present, or give a scene.pov_exception_reason where leaving them out is deliberate.";
    if (report.ratio < idn.hard_min_on_screen_ratio) {
      issues.error([...prefix, "segments"], `Viewer identification: ${detail}; at least ${pct(idn.hard_min_on_screen_ratio)} is required.${list}${fix}`);
    } else if (report.ratio < idn.min_on_screen_ratio) {
      issues.warn([...prefix, "segments"], `Viewer identification: ${detail}; the story asks for ${pct(idn.min_on_screen_ratio)}.${list}${fix}`);
    }
  }

  const card = idn.name_card;
  if (card?.enabled && doc.series.episode_number === card.episode) {
    const cards = doc.segments.filter((s) => (s.type === "title_card" || s.type === "infographic") && s.remotion?.template === NAME_CARD_TEMPLATE);
    if (cards.length === 0) {
      issues.warn([...prefix, "segments"], `Episode ${card.episode} should introduce ${povId} with one name card: a title_card segment with remotion.template "name_card" ("${card.text || "NAME · that's you"}").`);
    }
    for (const extra of cards.slice(1)) {
      issues.error(at(extra.id, "remotion", "template"), `${extra.id}: only one name card per episode (the first is ${cards[0].id}).`);
    }
  }
  return report;
}

/** Whole-word, case-insensitive matcher for the POV character's name and aliases (pronoun names are skipped). */
export function povNameMatcher(bible: StoryBible, povId: string): { re: RegExp; names: string[] } | null {
  const c = bible.characters.find((x) => x.id === povId);
  if (!c) return null;
  const pronouns = PRONOUN_NAMES as readonly string[];
  const names = [c.name, ...c.aliases].map((n) => n.trim()).filter((n) => n && !pronouns.includes(n.toLowerCase()));
  if (!names.length) return null;
  const alt = [...new Set(names)]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
  return { re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, "iu"), names };
}

/** A first-/second-person slip in narrator text: "I" in a second-person story, "you" in a first-person one. */
export function povDrift(text: string, pov: Pov): string | null {
  if (pov === "second_person") return /\b(I|I'm|I've|I'd|I'll)\b/.exec(text)?.[1] ?? /\b(me|my|mine|myself)\b/i.exec(text)?.[1] ?? null;
  if (pov === "first_person") return /\b(you|your|yours|yourself|you're|you've)\b/i.exec(text)?.[1] ?? null;
  return null;
}

// ── Segment roles ───────────────────────────────────────────────────────

export interface StructureCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface StructureReport {
  /** false: 2.0/2.1 episode or structure.enabled false; roles are listed but not checked. */
  applies: boolean;
  roles: { segment_id: string; order: number; role: SegmentRole; type: Seg["type"]; seconds: number }[];
  checks: StructureCheck[];
}

/** Role-order rules (warnings). Applies to schema 2.2 episodes with structure.enabled. */
export function checkStructure(
  doc: EpisodeDoc,
  structure: Structure,
  pov: Pov,
  pauseMs: number,
  issues: IssueSink,
  prefix: IssuePath = [],
): StructureReport {
  const ordered = byOrder(doc.segments);
  const roles = ordered.map((s) => ({ segment_id: s.id, order: s.order, role: s.role, type: s.type, seconds: estimateSegmentSeconds(s, pauseMs) }));
  const applies = doc.schema_version === "2.2" && structure.enabled;
  const checks: StructureCheck[] = [];
  if (!applies) return { applies, roles, checks };

  const segIndex = new Map(doc.segments.map((s, i) => [s.id, i]));
  const at = (id: string, ...p: IssuePath) => [...prefix, "segments", segIndex.get(id) ?? 0, ...p];
  const check = (id: string, label: string, ok: boolean, detail: string, path: IssuePath) => {
    checks.push({ id, label, ok, detail });
    if (!ok) issues.warn(path, `Structure: ${detail}`);
  };
  const positions = (role: SegmentRole) => ordered.map((s, i) => ({ s, i })).filter((x) => x.s.role === role);
  const epNo = doc.series.episode_number;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const recaps = positions("recap");

  if (epNo === 1) {
    if (structure.cold_open_first) {
      check("cold_open", "Cold open first", first?.role === "cold_open", first?.role === "cold_open" ? `${first.id} opens the episode.` : `episode 1 should open with a "cold_open" segment (${first?.id} is "${first?.role}").`, at(first.id, "role"));
    }
    check("no_recap", "No recap in episode 1", recaps.length === 0, recaps.length ? `episode 1 has nothing to recap (${recaps.map((r) => r.s.id).join(", ")}).` : "No recap.", recaps.length ? at(recaps[0].s.id, "role") : [...prefix, "segments"]);
  } else if (structure.recap_within_first > 0) {
    const early = recaps.filter((r) => r.i < structure.recap_within_first);
    check("recap", `Recap in the first ${structure.recap_within_first}`, early.length > 0, early.length ? `${early.map((r) => r.s.id).join(", ")} recaps the story so far.` : `episode ${epNo} should recap the story within its first ${structure.recap_within_first} segments (role "recap").`, recaps.length ? at(recaps[0].s.id, "role") : [...prefix, "segments"]);
    if (recaps.length) {
      const sec = recaps.reduce((sum, r) => sum + estimateSegmentSeconds(r.s, pauseMs), 0);
      check("recap_length", `Recap ≤ ${structure.recap_max_sec}s`, sec <= structure.recap_max_sec, sec <= structure.recap_max_sec ? `Recap is about ${Math.round(sec)} s.` : `the recap runs about ${Math.round(sec)} s; keep it under ${structure.recap_max_sec} s.`, at(recaps[0].s.id, "role"));
      const drift = recaps
        .flatMap((r) => segmentLines(r.s).filter((l) => l.speaker === NARRATOR).map((l) => ({ id: r.s.id, word: povDrift(l.text, pov) })))
        .find((x) => x.word);
      check("recap_pov", "Recap keeps the point of view", !drift, drift ? `the recap in ${drift.id} says "${drift.word}", which breaks the ${pov.replace("_", "-")} point of view.` : `Recap stays ${pov.replace("_", "-")}.`, at(drift?.id ?? recaps[0].s.id, "narration"));
    }
  }

  if (structure.status_board_within_first > 0) {
    const boards = positions("status_board");
    const n = structure.status_board_within_first;
    const ok = boards.length === 1 && boards[0].i < n;
    const detail =
      boards.length === 0
        ? `add one "status_board" segment (an infographic) within the first ${n} segments.`
        : boards.length > 1
          ? `exactly one status_board per episode (found ${boards.map((b) => b.s.id).join(", ")}).`
          : boards[0].i >= n
            ? `the status board ${boards[0].s.id} is segment ${boards[0].i + 1}; move it into the first ${n}.`
            : `${boards[0].s.id} is the status board.`;
    check("status_board", `One status board in the first ${n}`, ok, detail, boards.length ? at(boards[boards.length > 1 ? 1 : 0].s.id, "role") : [...prefix, "segments"]);
    for (const b of boards) {
      if (b.s.type !== "infographic") issues.warn(at(b.s.id, "type"), `Structure: the status board ${b.s.id} should be an infographic (it is ${b.s.type}).`);
    }
  }

  if (structure.cliffhanger_within_last > 0) {
    const n = structure.cliffhanger_within_last;
    const late = positions("cliffhanger").filter((c) => c.i >= ordered.length - n);
    if (doc.series.is_finale) checks.push({ id: "cliffhanger", label: "Cliffhanger", ok: true, detail: "Finale: no cliffhanger needed." });
    else check("cliffhanger", `Cliffhanger in the last ${n}`, late.length > 0, late.length ? `${late.map((c) => c.s.id).join(", ")} leaves the viewer hanging.` : `mark a "cliffhanger" segment within the last ${n} (or set series.is_finale).`, [...prefix, "segments"]);
  }

  if (structure.end_card_last) {
    const ends = positions("end_card");
    check("end_card", "End card last", last?.role === "end_card", last?.role === "end_card" ? `${last.id} closes the episode.` : `the last segment (${last?.id}) should have role "end_card".`, at(last.id, "role"));
    for (const e of ends.filter((x) => x.s !== last)) issues.warn(at(e.s.id, "role"), `Structure: ${e.s.id} is an end_card but isn't the last segment.`);
  }
  return { applies, roles, checks };
}

/** Chapters from runs of segment roles, for episodes without an explicit `chapters` list. Short runs merge into the previous chapter. */
export function roleChapters(
  segments: Seg[],
  starts: Record<string, number>,
  durationSec: number,
  mainTitle: string,
  minChapterSec = 10,
): { title: string; start_seconds: number }[] {
  const ordered = byOrder(segments).filter((s) => Number.isFinite(starts[s.id]));
  if (!ordered.some((s) => s.role !== "main")) return [];
  const runs: { role: SegmentRole; start: number }[] = [];
  for (const s of ordered) if (runs[runs.length - 1]?.role !== s.role) runs.push({ role: s.role, start: starts[s.id] });
  let mainCount = 0;
  const titled = runs.map((r) => ({
    title: r.role === "main" ? (mainCount++ === 0 ? mainTitle : `${mainTitle} (part ${mainCount})`) : ROLE_CHAPTER_TITLES[r.role],
    start_seconds: r.start,
  }));
  const out: typeof titled = [];
  for (let i = 0; i < titled.length; i++) {
    const c = titled[i];
    const next = titled[i + 1];
    const long = (next?.start_seconds ?? durationSec) - c.start_seconds >= minChapterSec;
    if (long || !next) {
      if (long || !out.length) out.push(c);
    } else if (!out.length) {
      // A short opening run is folded into the next chapter, which then starts at 0:00.
      titled[i + 1] = { ...next, start_seconds: c.start_seconds };
    }
    // Otherwise a short run is dropped and the previous chapter runs on over it.
  }
  if (out.length) out[0] = { ...out[0], start_seconds: 0 };
  return out;
}
