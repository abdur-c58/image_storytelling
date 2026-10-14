import { ABSENT_STATUSES, NARRATOR, PRONOUN_NAMES, REMOTE_VOICE_EFFECTS, schemaAtLeast } from "./constants";
import { segmentLines } from "./lines";
import type { BibleAdditions, EpisodeDoc, Location, StoryBible, WorldVariable } from "./schema";
import { checkIdentificationBible, identificationOf, povDrift, povNameMatcher } from "./structure";

export type IssuePath = (string | number)[];
export interface IssueSink {
  error(path: IssuePath, message: string): void;
  warn(path: IssuePath, message: string): void;
}

export type CharacterStatusName = StoryBible["characters"][number]["initial_status"];

export interface CharacterStatusEntry {
  status: CharacterStatusName;
  last_known_location_id: string | null;
  last_seen_episode: number | null;
  outfit_state_id: string;
}

/** Where the story stands after an episode: what the next episode starts from. */
export interface StoryStateSnapshot {
  after_episode: number;
  locations: Record<string, string>;
  world: Record<string, number | string>;
  outfits: Record<string, string>;
  introduced_characters: string[];
  /** Presence/absence of every character (schema 2.1; older snapshots lack it). */
  character_status?: Record<string, CharacterStatusEntry>;
}

export const isAbsent = (s: string) => (ABSENT_STATUSES as readonly string[]).includes(s);

/** Persisted on the story row; exportable as JSON from the Story page. */
export interface StoryState {
  current: StoryStateSnapshot;
  by_episode: Record<string, StoryStateSnapshot>;
  committed_through_episode: number;
}

export const DEFAULT_OUTFIT = "default";

export function baseStateId(loc: Location): string {
  return (loc.states.find((s) => s.is_base) ?? loc.states[0]).id;
}

export function defaultOutfitId(c: StoryBible["characters"][number]): string {
  return c.outfit_states[0]?.id ?? DEFAULT_OUTFIT;
}

export function initialSnapshot(bible: StoryBible): StoryStateSnapshot {
  return {
    after_episode: 0,
    locations: Object.fromEntries(bible.scene_bible.locations.map((l) => [l.id, baseStateId(l)])),
    world: Object.fromEntries(bible.scene_bible.world_variables.map((v) => [v.id, v.initial])),
    outfits: Object.fromEntries(bible.characters.map((c) => [c.id, defaultOutfitId(c)])),
    introduced_characters: [],
    character_status: Object.fromEntries(
      bible.characters.map((c) => [
        c.id,
        { status: c.initial_status, last_known_location_id: null, last_seen_episode: null, outfit_state_id: defaultOutfitId(c) },
      ]),
    ),
  };
}

export function initialStoryState(bible: StoryBible): StoryState {
  return { current: initialSnapshot(bible), by_episode: {}, committed_through_episode: 0 };
}

/** The snapshot an episode starts from: the latest committed episode before it, else the bible's initial state. */
export function startSnapshotFor(state: StoryState | null, bible: StoryBible, episodeNumber: number): StoryStateSnapshot {
  const fresh = initialSnapshot(bible);
  if (!state) return fresh;
  const prior = Object.values(state.by_episode)
    .filter((s) => s.after_episode < episodeNumber)
    .sort((a, b) => b.after_episode - a.after_episode)[0];
  if (!prior) return fresh;
  // Fill in anything the bible gained since (new locations, variables, characters).
  return {
    after_episode: prior.after_episode,
    locations: { ...fresh.locations, ...prior.locations },
    world: { ...fresh.world, ...prior.world },
    outfits: { ...fresh.outfits, ...prior.outfits },
    introduced_characters: [...prior.introduced_characters],
    character_status: { ...fresh.character_status, ...(prior.character_status ?? {}) },
  };
}

export function variableApplies(v: WorldVariable, loc: Location | undefined): boolean {
  if (!v.applies_to_location_tags.length) return true;
  return !!loc && loc.tags.some((t) => v.applies_to_location_tags.includes(t));
}

function checkWorldValue(v: WorldVariable, value: unknown): string | null {
  if (v.type === "integer" && !(typeof value === "number" && Number.isInteger(value))) return `"${v.id}" must be an integer.`;
  if (v.type === "number" && typeof value !== "number") return `"${v.id}" must be a number.`;
  if (v.type === "string" && typeof value !== "string") return `"${v.id}" must be a string.`;
  if (v.type === "enum" && !v.values.includes(String(value))) return `"${v.id}" must be one of: ${v.values.join(", ")}.`;
  return null;
}

/** In-bible consistency: unique ids, base states, world variable definitions, reference assets. */
export function checkStoryBible(bible: StoryBible, issues: IssueSink, prefix: IssuePath = []) {
  const at = (...p: IssuePath) => [...prefix, ...p];
  const dupes = <T extends { id: string }>(list: T[], path: IssuePath, what: string) => {
    const seen = new Set<string>();
    list.forEach((x, i) => {
      if (seen.has(x.id)) issues.error([...path, i, "id"], `Duplicate ${what} id "${x.id}".`);
      seen.add(x.id);
    });
  };
  dupes(bible.characters, at("characters"), "character");
  dupes(bible.scene_bible.locations, at("scene_bible", "locations"), "location");
  dupes(bible.scene_bible.world_variables, at("scene_bible", "world_variables"), "world variable");

  const refs = new Set(bible.style_bible.reference_assets.map((r) => r.id));
  bible.characters.forEach((c, ci) => {
    dupes(c.outfit_states, at("characters", ci, "outfit_states"), `outfit of ${c.id}`);
    c.reference_image_ids.forEach((rid, ri) => {
      if (!refs.has(rid)) {
        issues.error(at("characters", ci, "reference_image_ids", ri), `Unknown reference asset "${rid}". Add it to style_bible.reference_assets.`);
      }
    });
  });

  bible.scene_bible.locations.forEach((l, li) => {
    const lp = at("scene_bible", "locations", li);
    dupes(l.states, [...lp, "states"], `state of ${l.id}`);
    dupes(l.camera_angles, [...lp, "camera_angles"], `camera angle of ${l.id}`);
    dupes(l.key_props, [...lp, "key_props"], `prop of ${l.id}`);
    const bases = l.states.filter((s) => s.is_base);
    if (bases.length > 1) issues.error([...lp, "states"], `${l.id}: only one state can have "is_base": true.`);
    if (bases.length === 0) issues.warn([...lp, "states"], `${l.id}: no base state; "${l.states[0]?.id}" is used.`);
    l.states.forEach((s, si) => {
      if (s.derived_from && !l.states.some((x) => x.id === s.derived_from)) {
        issues.error([...lp, "states", si, "derived_from"], `${l.id}: unknown state "${s.derived_from}".`);
      }
    });
  });

  const charIds = new Set(bible.characters.map((c) => c.id));
  if (charIds.has(NARRATOR)) issues.error(at("characters"), `"${NARRATOR}" is reserved for the narrator; rename that character.`);
  const pov = bible.narrator.pov_character_id;
  if (pov && !charIds.has(pov)) issues.error(at("narrator", "pov_character_id"), `Unknown character "${pov}".`);
  if (bible.narrator.pov !== "third_person" && !pov && !bible.narrator.identification?.pov_character_id) {
    issues.warn(at("narrator", "pov_character_id"), `A ${bible.narrator.pov.replace("_", "-")} story should name its POV character (pov_character_id).`);
  }
  checkIdentificationBible(bible, issues, at);
  dupes(bible.character_groups, at("character_groups"), "character group");
  bible.character_groups.forEach((g, gi) => {
    g.character_ids.forEach((cid, ci) => {
      if (!charIds.has(cid)) issues.error(at("character_groups", gi, "character_ids", ci), `${g.id}: unknown character "${cid}".`);
    });
    if (new Set(g.character_ids).size !== g.character_ids.length) issues.error(at("character_groups", gi, "character_ids"), `${g.id}: a character is listed twice.`);
  });
  checkSharedVoices(bible, issues, prefix);

  bible.scene_bible.world_variables.forEach((v, vi) => {
    const vp = at("scene_bible", "world_variables", vi);
    if (v.type === "enum" && v.values.length === 0) issues.error([...vp, "values"], `${v.id}: enum variables need "values".`);
    const bad = checkWorldValue(v, v.initial);
    if (bad) issues.error([...vp, "initial"], bad);
    if (v.monotonic && v.type !== "integer" && v.type !== "number") {
      issues.error([...vp, "monotonic"], `${v.id}: only numeric variables can be monotonic.`);
    }
    for (const m of v.prompt_template.matchAll(/\{([a-z0-9_-]+)\}/gi)) {
      if (m[1] !== "value") issues.warn([...vp, "prompt_template"], `${v.id}: placeholder "{${m[1]}}" is not filled; use "{value}".`);
    }
  });
}

/** Speakers sharing a voice_id sound alike; warn unless they declare the same voice_group. */
export function checkSharedVoices(bible: StoryBible, issues: IssueSink, prefix: IssuePath = []) {
  const speakers: { id: string; voice_id: string; group: string | null; path: IssuePath }[] = [];
  const narratorVoice = bible.narrator.voice?.voice_id || bible.defaults.voice.voice_id;
  if (narratorVoice) speakers.push({ id: NARRATOR, voice_id: narratorVoice, group: null, path: [...prefix, "narrator", "voice", "voice_id"] });
  bible.characters.forEach((c, i) => {
    if (c.voice?.voice_id) speakers.push({ id: c.id, voice_id: c.voice.voice_id, group: c.voice_group, path: [...prefix, "characters", i, "voice", "voice_id"] });
  });
  speakers.forEach((s, i) => {
    const twin = speakers.slice(0, i).find((o) => o.voice_id === s.voice_id && !(o.group && o.group === s.group));
    if (twin) issues.warn(s.path, `${s.id} uses the same voice_id as ${twin.id}; listeners won't tell them apart (give both the same voice_group if that's intended).`);
  });
}

/** bible_additions are append-only: every id must be new, and attachments must point at existing parents. */
export function checkBibleAdditions(bible: StoryBible, add: BibleAdditions, issues: IssueSink, prefix: IssuePath = []) {
  const at = (...p: IssuePath) => [...prefix, "bible_additions", ...p];
  const appendOnly = "bible_additions can only add; change the story bible instead.";
  const newLocations = new Map(add.locations.map((l) => [l.id, l]));
  const locById = (id: string) => bible.scene_bible.locations.find((l) => l.id === id) ?? newLocations.get(id);
  // An addition already merged into the story (a re-imported episode) is fine when it is unchanged.
  const conflicts = <T extends { id: string }>(list: T[], item: T) => {
    const found = list.find((x) => x.id === item.id);
    return !!found && JSON.stringify(found) !== JSON.stringify(item);
  };

  add.characters.forEach((c, i) => {
    if (conflicts(bible.characters, c)) issues.error(at("characters", i, "id"), `Character "${c.id}" already exists; ${appendOnly}`);
  });
  add.character_groups.forEach((g, i) => {
    if (conflicts(bible.character_groups, g)) issues.error(at("character_groups", i, "id"), `Character group "${g.id}" already exists; ${appendOnly}`);
    g.character_ids.forEach((cid, ci) => {
      if (!bible.characters.some((c) => c.id === cid) && !add.characters.some((c) => c.id === cid)) {
        issues.error(at("character_groups", i, "character_ids", ci), `${g.id}: unknown character "${cid}".`);
      }
    });
  });
  add.world_variables.forEach((v, i) => {
    if (conflicts(bible.scene_bible.world_variables, v)) {
      issues.error(at("world_variables", i, "id"), `World variable "${v.id}" already exists; ${appendOnly}`);
    }
    const bad = checkWorldValue(v, v.initial);
    if (bad) issues.error(at("world_variables", i, "initial"), bad);
  });
  add.locations.forEach((l, i) => {
    if (conflicts(bible.scene_bible.locations, l)) issues.error(at("locations", i, "id"), `Location "${l.id}" already exists; ${appendOnly}`);
  });
  const attach = <T extends { id: string }>(
    list: { location_id: string; item: T }[],
    key: string,
    pick: (l: Location) => T[],
    what: string,
  ) => {
    list.forEach(({ location_id, item }, i) => {
      const loc = locById(location_id);
      if (!loc) issues.error(at(key, i, "location_id"), `Unknown location "${location_id}".`);
      else if (conflicts(pick(loc), item)) issues.error(at(key, i), `${location_id} already has ${what} "${item.id}"; ${appendOnly}`);
    });
  };
  attach(add.location_states.map((x) => ({ location_id: x.location_id, item: x.state })), "location_states", (l) => l.states, "state");
  attach(add.camera_angles.map((x) => ({ location_id: x.location_id, item: x.angle })), "camera_angles", (l) => l.camera_angles, "camera angle");
  attach(add.key_props.map((x) => ({ location_id: x.location_id, item: x.prop })), "key_props", (l) => l.key_props, "prop");
  add.location_states.forEach(({ location_id, state }, i) => {
    const loc = locById(location_id);
    const known = [...(loc?.states ?? []), ...add.location_states.filter((x) => x.location_id === location_id).map((x) => x.state)];
    if (state.derived_from && !known.some((s) => s.id === state.derived_from)) {
      issues.error(at("location_states", i, "state", "derived_from"), `${location_id}: unknown state "${state.derived_from}".`);
    }
    if (state.is_base) issues.error(at("location_states", i, "state", "is_base"), `${location_id}: an added state cannot be the base state.`);
  });
  add.outfit_states.forEach(({ character_id, outfit }, i) => {
    const c = bible.characters.find((x) => x.id === character_id) ?? add.characters.find((x) => x.id === character_id);
    if (!c) issues.error(at("outfit_states", i, "character_id"), `Unknown character "${character_id}".`);
    else if (conflicts(c.outfit_states, outfit)) {
      issues.error(at("outfit_states", i), `${character_id} already has outfit "${outfit.id}"; ${appendOnly}`);
    }
  });
}

export interface ContinuityResult {
  end: StoryStateSnapshot;
  /** (location, state, angle) combinations the episode's scenes use. */
  usedViews: { location_id: string; state_id: string; camera_angle_id: string }[];
  /** (character, outfit) pairs the episode's scenes use. */
  usedOutfits: { character_id: string; outfit_state_id: string }[];
  /** Character groups that share a picture. */
  usedGroups: string[];
}

/**
 * Walk the episode's scenes in order against the story state, reporting continuity breaks with the path of the
 * offending field. `bible` must already include this episode's additions.
 */
export function checkContinuity(
  bible: StoryBible,
  doc: EpisodeDoc,
  start: StoryStateSnapshot,
  issues: IssueSink,
  prefix: IssuePath = [],
): ContinuityResult {
  const epNo = doc.series.episode_number;
  const locations = new Map(bible.scene_bible.locations.map((l) => [l.id, l]));
  const vars = new Map(bible.scene_bible.world_variables.map((v) => [v.id, v]));
  const chars = new Map(bible.characters.map((c) => [c.id, c]));
  const addedChars = new Set(doc.bible_additions.characters.map((c) => c.id));
  const state: StoryStateSnapshot = structuredClone(start);
  state.after_episode = epNo;
  for (const l of bible.scene_bible.locations) state.locations[l.id] ??= baseStateId(l);
  for (const v of bible.scene_bible.world_variables) state.world[v.id] ??= v.initial;
  for (const c of bible.characters) state.outfits[c.id] ??= defaultOutfitId(c);
  const introduced = new Set(state.introduced_characters);
  const views = new Map<string, ContinuityResult["usedViews"][number]>();
  const outfits = new Map<string, ContinuityResult["usedOutfits"][number]>();
  const groups = new Set<string>();
  const cameo = bible.channel.recurring_cameo;
  let cameoCount = 0;
  const lastWorldAt = new Map<string, number>();
  /** Locations whose state this episode already changed (messages then point at the change, not the previous episode). */
  const changedHere = new Set<string>();
  const startSource = start.after_episode > 0 ? `the story state after Episode ${start.after_episode}` : "the story's initial state";

  // ── Character status ──────────────────────────────────────────────
  const status = (state.character_status ??= {});
  for (const c of bible.characters) {
    status[c.id] ??= { status: c.initial_status, last_known_location_id: null, last_seen_episode: null, outfit_state_id: defaultOutfitId(c) };
  }
  const segIndex = new Map(doc.segments.map((s, i) => [s.id, i]));
  const changesAt = new Map<string, { change: EpisodeDoc["character_status_changes"][number]; index: number }[]>();
  doc.character_status_changes.forEach((change, index) => {
    const cp = [...prefix, "character_status_changes", index];
    if (!chars.has(change.character_id)) {
      issues.error([...cp, "character_id"], `Unknown character "${change.character_id}".`);
      return;
    }
    if (!segIndex.has(change.at_segment_id)) {
      issues.error([...cp, "at_segment_id"], `Unknown segment "${change.at_segment_id}".`);
      return;
    }
    const list = changesAt.get(change.at_segment_id) ?? [];
    list.push({ change, index });
    changesAt.set(change.at_segment_id, list);
  });
  /** Absent statuses start after their segment (the parting is shown); others start at it (the return is shown). */
  const applyChanges = (segId: string, phase: "before" | "after", locationId: string | null) => {
    for (const { change, index } of changesAt.get(segId) ?? []) {
      if (isAbsent(change.to_status) !== (phase === "after")) continue;
      const cp = [...prefix, "character_status_changes", index];
      const entry = status[change.character_id];
      if (entry.status === "deceased" && change.to_status !== "deceased" && !change.story_override) {
        issues.error([...cp, "to_status"], `${change.character_id} is deceased; bringing them back needs "story_override": true.`);
        continue;
      }
      if (entry.status === change.to_status) issues.warn([...cp, "to_status"], `${change.character_id} is already "${change.to_status}".`);
      entry.status = change.to_status;
      if (locationId) entry.last_known_location_id = locationId;
    }
  };
  const seen = (cid: string, locationId: string | null) => {
    const entry = status[cid];
    if (!entry) return;
    entry.last_seen_episode = epNo;
    if (locationId) entry.last_known_location_id = locationId;
  };
  const absentHere = (cid: string) => isAbsent(status[cid]?.status ?? "with_protagonist");

  // ── POV ───────────────────────────────────────────────────────────
  const identification = identificationOf(bible);
  const povId = identification?.pov_character_id ?? bible.narrator.pov_character_id;
  const povChar = povId ? chars.get(povId) : undefined;
  const povName = povChar && !(PRONOUN_NAMES as readonly string[]).includes(povChar.name.trim().toLowerCase()) ? povChar.name.trim() : null;
  const povNameRe = povName ? new RegExp(`\\b${povName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  const secondPerson = bible.narrator.pov === "second_person";
  /** 2.2 identification: name + aliases, and an error unless forbid_narrator_name is false. */
  const idNames = identification && povId ? povNameMatcher(bible, povId) : null;
  const driftCheck = schemaAtLeast(doc.schema_version, "2.2");

  // ── Lines: speakers, voices, absence ─────────────────────────────
  const checkLines = (seg: EpisodeDoc["segments"][number], i: number, present: boolean, locationId: string | null) => {
    const inFrame = new Set(seg.scene?.characters_present.map((c) => c.character_id) ?? []);
    segmentLines(seg).forEach((line, li) => {
      const lp = seg.lines?.length ? [...prefix, "segments", i, "lines", li] : [...prefix, "segments", i, "narration"];
      if (line.speaker === NARRATOR) {
        if (identification) {
          const hit = idNames?.re.exec(line.text)?.[0];
          if (hit) {
            const msg = `${seg.id}: the narrator names the viewer's character ("${hit}"); the viewer is ${povId}, so say "you".`;
            if (identification.forbid_narrator_name) issues.error([...lp], msg);
            else issues.warn([...lp], msg);
          }
        } else if (secondPerson && povNameRe?.test(line.text)) {
          issues.warn([...lp], `${seg.id}: in a second-person story the narrator shouldn't name the POV character ("${povName}"); say "you".`);
        }
        const drift = driftCheck && seg.role !== "recap" ? povDrift(line.text, bible.narrator.pov) : null;
        if (drift) issues.warn([...lp], `${seg.id}: the narrator says "${drift}" in a ${bible.narrator.pov.replace("_", "-")} story.`);
        return;
      }
      const c = chars.get(line.speaker);
      if (!c) {
        issues.error([...lp, "speaker"], `${seg.id}: unknown speaker "${line.speaker}" (use "${NARRATOR}" or a character id).`);
        return;
      }
      if (!c.voice) {
        issues.error([...lp, "speaker"], `${seg.id}: ${c.id} has no "voice" in the story bible, so it can't speak lines.`);
      } else if (!c.voice.voice_id) {
        issues.warn([...lp, "speaker"], `${seg.id}: ${c.id} has no voice_id; set one on the Story page, or the default voice from Settings will be used.`);
      }
      const remote = (REMOTE_VOICE_EFFECTS as readonly string[]).includes(line.voice_effect) || line.source === "written";
      if (present && absentHere(c.id) && !remote) {
        issues.error(
          [...lp, "speaker"],
          `${seg.id}: ${c.id} is "${status[c.id].status}" here, so they can't speak in the present. Use voice_effect "radio"/"phone", source "written", a flashback, or a character_status_changes entry.`,
        );
      }
      if (remote && line.on_screen && line.source === "spoken") {
        issues.warn([...lp, "on_screen"], `${seg.id}: a ${line.voice_effect} voice is not in the frame; set "on_screen": false.`);
      }
      if (line.on_screen && seg.type === "illustration" && seg.scene && !inFrame.has(c.id) && !remote) {
        issues.warn([...lp, "on_screen"], `${seg.id}: ${c.id} speaks on screen but isn't in scene.characters_present.`);
      }
      if (present && line.on_screen && !remote) seen(c.id, locationId);
    });
  };

  const walkScene = (seg: EpisodeDoc["segments"][number], i: number) => {
    const at = (...p: IssuePath) => [...prefix, "segments", i, ...p];
    const label = seg.id;
    if (seg.type === "illustration" && !seg.scene) {
      issues.error(at("scene"), `${label}: illustration segments need a "scene" block.`);
      return;
    }
    if (!seg.scene) return;
    if (seg.type === "reuse_image") {
      issues.warn(at("scene"), `${label}: reuse_image shows its source's picture; this scene is used for continuity only.`);
    }
    const scene = seg.scene;
    const present = scene.timeframe === "present";
    const loc = locations.get(scene.location_id);
    if (!loc) {
      issues.error(at("scene", "location_id"), `${label}: unknown location "${scene.location_id}".`);
      return;
    }
    if (scene.visual_treatment === "flashback_tint" && present) {
      issues.warn(at("scene", "visual_treatment"), `${label}: flashback_tint on a present-day scene.`);
    }
    if (!present && scene.state_changes.length) {
      issues.warn(at("scene", "state_changes"), `${label}: a ${scene.timeframe} scene doesn't change the story; these state_changes are ignored.`);
    }

    const temporary: Record<string, string> = {};
    (present ? scene.state_changes : []).forEach((ch, ci) => {
      const cp = at("scene", "state_changes", ci);
      const target = locations.get(ch.location_id);
      if (!target) {
        issues.error([...cp, "location_id"], `${label}: unknown location "${ch.location_id}".`);
        return;
      }
      const current = temporary[ch.location_id] ?? state.locations[ch.location_id];
      if (!target.states.some((s) => s.id === ch.from_state_id)) {
        issues.error([...cp, "from_state_id"], `${label}: ${ch.location_id} has no state "${ch.from_state_id}".`);
      } else if (ch.from_state_id !== current) {
        issues.error(
          [...cp, "from_state_id"],
          `${label}: ${ch.location_id} is "${current}" at this point, not "${ch.from_state_id}".`,
        );
      }
      if (!target.states.some((s) => s.id === ch.to_state_id)) {
        issues.error([...cp, "to_state_id"], `${label}: ${ch.location_id} has no state "${ch.to_state_id}". Add it in bible_additions.location_states.`);
        return;
      }
      if (ch.persist) state.locations[ch.location_id] = ch.to_state_id;
      else temporary[ch.location_id] = ch.to_state_id;
      changedHere.add(ch.location_id);
    });

    const expected = temporary[loc.id] ?? state.locations[loc.id];
    if (!loc.states.some((s) => s.id === scene.state_id)) {
      issues.error(at("scene", "state_id"), `${label}: ${loc.id} has no state "${scene.state_id}".`);
    } else if (present && scene.state_id !== expected && !changedHere.has(loc.id)) {
      issues.error(
        at("scene", "state_id"),
        `${label}: Episode ${epNo} uses location '${loc.id}' in state '${scene.state_id}', but ${startSource} is '${expected}' and no state change is declared.`,
      );
    } else if (present && scene.state_id !== expected) {
      issues.error(
        at("scene", "state_id"),
        `${label}: ${loc.id} is "${expected}" here, but the scene says "${scene.state_id}". Add a state_change or fix the state.`,
      );
    }
    if (!loc.camera_angles.some((a) => a.id === scene.camera_angle_id)) {
      issues.error(at("scene", "camera_angle_id"), `${label}: ${loc.id} has no camera angle "${scene.camera_angle_id}".`);
    } else if (seg.type === "illustration") {
      const key = `${loc.id}/${scene.state_id}/${scene.camera_angle_id}`;
      views.set(key, { location_id: loc.id, state_id: scene.state_id, camera_angle_id: scene.camera_angle_id });
    }

    for (const [vid, value] of Object.entries(scene.world_state)) {
      const v = vars.get(vid);
      const wp = at("scene", "world_state", vid);
      if (!v) {
        issues.error(wp, `${label}: unknown world variable "${vid}".`);
        continue;
      }
      const bad = checkWorldValue(v, value);
      if (bad) {
        issues.error(wp, `${label}: ${bad}`);
        continue;
      }
      if (!present) continue;
      const prev = state.world[vid];
      if (typeof prev === "number" && typeof value === "number") {
        if (v.monotonic === "increasing" && value < prev) issues.warn(wp, `${label}: "${vid}" goes down (${prev} → ${value}) but is monotonic increasing.`);
        if (v.monotonic === "decreasing" && value > prev) issues.warn(wp, `${label}: "${vid}" goes up (${prev} → ${value}) but is monotonic decreasing.`);
        const sinceLast = i - (lastWorldAt.get(vid) ?? i - 1);
        if (v.max_step_per_segment !== null && Math.abs(value - prev) > v.max_step_per_segment * Math.max(1, sinceLast)) {
          issues.warn(wp, `${label}: "${vid}" jumps ${prev} → ${value}, more than ${v.max_step_per_segment} per segment.`);
        }
      }
      state.world[vid] = value;
      lastWorldAt.set(vid, i);
    }
    if (seg.type === "illustration" && present) {
      for (const v of bible.scene_bible.world_variables) {
        if (variableApplies(v, loc) && v.prompt_template && !(v.id in scene.world_state)) {
          issues.error(at("scene", "world_state"), `${label}: missing world variable "${v.id}" (applies to ${loc.id}). Current value: ${JSON.stringify(state.world[v.id])}.`);
        }
      }
    }

    scene.characters_present.forEach((cp, ci) => {
      const p = at("scene", "characters_present", ci);
      const c = chars.get(cp.character_id);
      if (!c) {
        issues.error([...p, "character_id"], `${label}: unknown character "${cp.character_id}".`);
        return;
      }
      const debuts = c.first_appears_episode <= epNo || addedChars.has(c.id);
      if (!introduced.has(c.id) && !debuts && !cp.cameo) {
        issues.error(
          [...p, "character_id"],
          `${label}: ${c.id} first appears in episode ${c.first_appears_episode}. Mark "cameo": true or change first_appears_episode.`,
        );
      }
      if (!cp.cameo) introduced.add(c.id);
      if (present && absentHere(c.id)) {
        issues.error(
          [...p, "character_id"],
          `${label}: ${c.id} is "${status[c.id].status}" at this point and can't be in a present-day picture. Add a character_status_changes entry, or make the scene a flashback/imagined.`,
        );
      }
      if (cp.outfit_state_id) {
        const known = c.outfit_states.some((o) => o.id === cp.outfit_state_id) || (cp.outfit_state_id === DEFAULT_OUTFIT && !c.outfit_states.length);
        if (!known) {
          issues.error([...p, "outfit_state_id"], `${label}: ${c.id} has no outfit "${cp.outfit_state_id}". Add it in bible_additions.outfit_states.`);
          return;
        }
        if (present) state.outfits[c.id] = cp.outfit_state_id;
      }
      const outfit = (present ? state.outfits[c.id] : cp.outfit_state_id ?? state.outfits[c.id]) ?? defaultOutfitId(c);
      if (seg.type === "illustration") outfits.set(`${c.id}/${outfit}`, { character_id: c.id, outfit_state_id: outfit });
      if (present && !cp.cameo) {
        seen(c.id, loc.id);
        status[c.id].outfit_state_id = outfit;
      }
    });

    if (
      secondPerson &&
      povId &&
      !identification &&
      !scene.pov_exception_reason &&
      present &&
      seg.type === "illustration" &&
      !scene.characters_present.some((cp) => cp.character_id === povId)
    ) {
      issues.warn(at("scene", "characters_present"), `${label}: second-person story, but the POV character (${povId}) isn't in this present-day picture.`);
    }
    if (seg.type === "illustration") for (const g of groupsIn(bible, scene.characters_present)) groups.add(g);
    const crowd = scene.characters_present.filter((cp) => !cp.cameo).length;
    if (crowd >= 2) {
      const positions = scene.characters_present.filter((cp) => !cp.cameo).map((cp) => cp.position_in_frame);
      if (new Set(positions).size < positions.length && !positions.includes("background")) {
        issues.warn(at("scene", "characters_present"), `${label}: two characters share position "${positions.find((p, k) => positions.indexOf(p) !== k)}"; give each its own position_in_frame so they don't merge.`);
      }
    }

    scene.props_in_frame.forEach((pid, pi) => {
      if (!loc.key_props.some((p) => p.id === pid)) issues.error(at("scene", "props_in_frame", pi), `${label}: ${loc.id} has no prop "${pid}".`);
    });

    if (scene.include_channel_cameo) {
      cameoCount++;
      if (!cameo) issues.warn(at("scene", "include_channel_cameo"), `${label}: the story bible has no channel.recurring_cameo.`);
    }
  };

  doc.segments.forEach((seg, i) => {
    const present = (seg.scene?.timeframe ?? "present") === "present";
    const locationId = seg.scene && present ? seg.scene.location_id : null;
    applyChanges(seg.id, "before", locationId);
    walkScene(seg, i);
    checkLines(seg, i, present, locationId);
    applyChanges(seg.id, "after", locationId);
  });

  if (cameo?.min_segments_per_episode && cameoCount < cameo.min_segments_per_episode) {
    issues.warn([...prefix, "segments"], `The channel cameo appears in ${cameoCount} segment(s); the bible asks for at least ${cameo.min_segments_per_episode}.`);
  }

  const th = doc.thumbnail.scene;
  if (th) {
    const tp = [...prefix, "thumbnail", "scene"];
    const loc = locations.get(th.location_id);
    if (!loc) issues.error([...tp, "location_id"], `Thumbnail: unknown location "${th.location_id}".`);
    else {
      if (!loc.states.some((s) => s.id === th.state_id)) issues.error([...tp, "state_id"], `Thumbnail: ${loc.id} has no state "${th.state_id}".`);
      if (!loc.camera_angles.some((a) => a.id === th.camera_angle_id)) {
        issues.error([...tp, "camera_angle_id"], `Thumbnail: ${loc.id} has no camera angle "${th.camera_angle_id}".`);
      } else if (loc.states.some((s) => s.id === th.state_id)) {
        const key = `${loc.id}/${th.state_id}/${th.camera_angle_id}`;
        views.set(key, { location_id: loc.id, state_id: th.state_id, camera_angle_id: th.camera_angle_id });
      }
    }
  }
  doc.thumbnail.characters_present.forEach((cid, ci) => {
    if (!chars.has(cid)) issues.error([...prefix, "thumbnail", "characters_present", ci], `Unknown character "${cid}".`);
  });
  if (doc.thumbnail.pairing_layout && doc.thumbnail.characters_present.length < 2) {
    issues.warn([...prefix, "thumbnail", "pairing_layout"], "pairing_layout is only used with two or more characters_present.");
  }

  state.introduced_characters = [...introduced].sort();
  return { end: state, usedViews: [...views.values()], usedOutfits: [...outfits.values()], usedGroups: [...groups].sort() };
}

/** Character groups whose members are all (non-cameo) in a picture. */
export function groupsIn(bible: Pick<StoryBible, "character_groups">, present: { character_id: string; cameo?: boolean }[]): string[] {
  const ids = new Set(present.filter((p) => !p.cameo).map((p) => p.character_id));
  return bible.character_groups.filter((g) => g.character_ids.every((c) => ids.has(c))).map((g) => g.id);
}

export function masterKeyForGroup(groupId: string): string {
  return `group/${groupId}`;
}

export function masterKeyForView(v: { location_id: string; state_id: string; camera_angle_id: string }): string {
  return `loc/${v.location_id}/${v.state_id}/${v.camera_angle_id}`;
}

export function masterKeyForOutfit(v: { character_id: string; outfit_state_id: string }): string {
  return `char/${v.character_id}/${v.outfit_state_id}`;
}
