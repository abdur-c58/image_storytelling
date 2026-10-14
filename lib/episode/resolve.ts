import {
  AudioSchema,
  CropPolicySchema,
  RenderSchema,
  VoiceSchema,
  type BibleAdditions,
  type CropPolicy,
  type Episode,
  type EpisodeDoc,
  type StoryBible,
} from "./schema";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * The bible with an episode's `bible_additions` appended. Additions are append-only: callers validate first
 * (validateBibleAdditions) so nothing here overwrites an existing id; anything that would is skipped.
 */
export function applyBibleAdditions(bible: StoryBible, add: BibleAdditions | undefined): StoryBible {
  const out = clone(bible);
  if (!add) return out;
  const has = <T extends { id: string }>(list: T[], id: string) => list.some((x) => x.id === id);
  for (const c of add.characters) if (!has(out.characters, c.id)) out.characters.push(clone(c));
  for (const v of add.world_variables) {
    if (!has(out.scene_bible.world_variables, v.id)) out.scene_bible.world_variables.push(clone(v));
  }
  for (const l of add.locations) if (!has(out.scene_bible.locations, l.id)) out.scene_bible.locations.push(clone(l));
  const loc = (id: string) => out.scene_bible.locations.find((l) => l.id === id);
  for (const { location_id, state } of add.location_states) {
    const l = loc(location_id);
    if (l && !has(l.states, state.id)) l.states.push(clone(state));
  }
  for (const { location_id, angle } of add.camera_angles) {
    const l = loc(location_id);
    if (l && !has(l.camera_angles, angle.id)) l.camera_angles.push(clone(angle));
  }
  for (const { location_id, prop } of add.key_props) {
    const l = loc(location_id);
    if (l && !has(l.key_props, prop.id)) l.key_props.push(clone(prop));
  }
  for (const { character_id, outfit } of add.outfit_states) {
    const c = out.characters.find((x) => x.id === character_id);
    if (c && !has(c.outfit_states, outfit.id)) c.outfit_states.push(clone(outfit));
  }
  return out;
}

export function mergeCropPolicy(base: CropPolicy, ...overrides: (Record<string, unknown> | null | undefined)[]): CropPolicy {
  let merged: Record<string, unknown> = { ...base };
  for (const o of overrides) if (o) merged = { ...merged, ...stripUndefined(o) };
  return CropPolicySchema.parse(merged);
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Story + episode → the single document the pipeline and the worker read. */
export function resolveEpisode(bible: StoryBible, doc: EpisodeDoc): Episode {
  const story = applyBibleAdditions(bible, doc.bible_additions);
  const o = doc.overrides ?? {};
  const audioOverride = (o.audio ?? {}) as Record<string, unknown>;
  const { music: musicOverride, ...audioRest } = audioOverride;
  const voice = VoiceSchema.parse({ ...story.defaults.voice, ...stripUndefined((o.voice ?? {}) as Record<string, unknown>) });
  const audio = AudioSchema.parse({
    ...story.defaults.audio,
    ...stripUndefined(audioRest),
    music: { ...story.defaults.audio.music, ...stripUndefined((musicOverride ?? {}) as Record<string, unknown>) },
  });
  const render = RenderSchema.parse({ ...story.defaults.render, ...stripUndefined((o.render ?? {}) as Record<string, unknown>) });
  const crop_policy = mergeCropPolicy(story.defaults.crop_policy, o.crop_policy as Record<string, unknown> | undefined);

  const rest = clone(doc);
  return {
    ...rest,
    series: {
      ...rest.series,
      series_id: story.story_id,
      series_title: story.story_title,
      total_episodes_planned: story.total_episodes_planned,
    },
    youtube: { ...rest.youtube, channel_name: rest.youtube.channel_name || story.channel.channel_name },
    style_bible: {
      ...clone(story.style_bible),
      characters: story.characters.map((c) => ({
        id: c.id,
        name: c.name,
        visual_description: c.visual_description,
        reference_image_ids: [...c.reference_image_ids],
      })),
    },
    voice,
    audio,
    render,
    crop_policy,
    story: {
      story_id: story.story_id,
      story_title: story.story_title,
      channel: clone(story.channel),
      characters: clone(story.characters),
      scene_bible: clone(story.scene_bible),
    },
  };
}

export function isResolvedV2(ep: unknown): ep is Episode {
  return !!ep && typeof ep === "object" && "story" in ep && "crop_policy" in ep;
}
