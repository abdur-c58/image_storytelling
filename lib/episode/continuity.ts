import type { BibleAdditions, EpisodeDoc, Location, StoryBible, WorldVariable } from "./schema";

export type IssuePath = (string | number)[];
export interface IssueSink {
  error(path: IssuePath, message: string): void;
  warn(path: IssuePath, message: string): void;
}

/** Where the story stands after an episode: what the next episode starts from. */
export interface StoryStateSnapshot {
  after_episode: number;
  locations: Record<string, string>;
  world: Record<string, number | string>;
  outfits: Record<string, string>;
  introduced_characters: string[];
}

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
  const cameo = bible.channel.recurring_cameo;
  let cameoCount = 0;
  const lastWorldAt = new Map<string, number>();

  doc.segments.forEach((seg, i) => {
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
    const loc = locations.get(scene.location_id);
    if (!loc) {
      issues.error(at("scene", "location_id"), `${label}: unknown location "${scene.location_id}".`);
      return;
    }

    const temporary: Record<string, string> = {};
    scene.state_changes.forEach((ch, ci) => {
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
    });

    const expected = temporary[loc.id] ?? state.locations[loc.id];
    if (!loc.states.some((s) => s.id === scene.state_id)) {
      issues.error(at("scene", "state_id"), `${label}: ${loc.id} has no state "${scene.state_id}".`);
    } else if (scene.state_id !== expected) {
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
    if (seg.type === "illustration") {
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
      if (cp.outfit_state_id) {
        const known = c.outfit_states.some((o) => o.id === cp.outfit_state_id) || (cp.outfit_state_id === DEFAULT_OUTFIT && !c.outfit_states.length);
        if (!known) {
          issues.error([...p, "outfit_state_id"], `${label}: ${c.id} has no outfit "${cp.outfit_state_id}". Add it in bible_additions.outfit_states.`);
          return;
        }
        state.outfits[c.id] = cp.outfit_state_id;
      }
      const outfit = state.outfits[c.id] ?? defaultOutfitId(c);
      if (seg.type === "illustration") outfits.set(`${c.id}/${outfit}`, { character_id: c.id, outfit_state_id: outfit });
    });

    scene.props_in_frame.forEach((pid, pi) => {
      if (!loc.key_props.some((p) => p.id === pid)) issues.error(at("scene", "props_in_frame", pi), `${label}: ${loc.id} has no prop "${pid}".`);
    });

    if (scene.include_channel_cameo) {
      cameoCount++;
      if (!cameo) issues.warn(at("scene", "include_channel_cameo"), `${label}: the story bible has no channel.recurring_cameo.`);
    }
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

  state.introduced_characters = [...introduced].sort();
  return { end: state, usedViews: [...views.values()], usedOutfits: [...outfits.values()] };
}

export function masterKeyForView(v: { location_id: string; state_id: string; camera_angle_id: string }): string {
  return `loc/${v.location_id}/${v.state_id}/${v.camera_angle_id}`;
}

export function masterKeyForOutfit(v: { character_id: string; outfit_state_id: string }): string {
  return `char/${v.character_id}/${v.outfit_state_id}`;
}
