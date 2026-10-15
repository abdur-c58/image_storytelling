import {
  AudioSchema,
  CropPolicySchema,
  RenderSchema,
  StoredStoryBibleSchema,
  StructureSchema,
  VoiceSchema,
  type BibleAdditions,
  type CropPolicy,
  type Episode,
  type EpisodeDoc,
  type ResolvedVoice,
  type StoryBible,
  type Voice,
} from "./schema";
import { NAME_CARD_DEFAULT_SECONDS, NAME_CARD_TEMPLATE, NARRATOR } from "./constants";
import { segmentLines } from "./lines";

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
  for (const g of add.character_groups ?? []) if (!has(out.character_groups, g.id)) out.character_groups.push(clone(g));
  return out;
}

/**
 * The voice each speaker uses: the narrator from narrator.voice over defaults.voice, characters from their own.
 * An episode's `overrides.voice.speed` beats the story's narrator speed; characters keep their own speed.
 */
export function speakerVoices(story: StoryBible, voice: Voice, episodeOverride?: { speed?: number }): Record<string, ResolvedVoice> {
  const n = story.narrator.voice;
  const out: Record<string, ResolvedVoice> = {
    [NARRATOR]: {
      voice_id: n?.voice_id || voice.voice_id,
      model: n?.model || voice.model,
      speed: episodeOverride?.speed ?? n?.speed ?? voice.speed,
      gain_db: n?.gain_db ?? 0,
      style_notes: voice.style_notes,
      pronunciation_overrides: { ...voice.pronunciation_overrides },
    },
  };
  for (const c of story.characters) {
    if (!c.voice) continue;
    out[c.id] = {
      voice_id: c.voice.voice_id,
      model: c.voice.model || voice.model,
      speed: c.voice.speed,
      gain_db: c.voice.gain_db,
      style_notes: c.voice.style_notes,
      pronunciation_overrides: { ...voice.pronunciation_overrides, ...c.voice.pronunciation_overrides },
    };
  }
  return out;
}

/** Every spoken segment gets `lines`; narration/tts_text/caption_text become the joined lines for whole-text uses. */
function normaliseLines(seg: EpisodeDoc["segments"][number]): EpisodeDoc["segments"][number] {
  if (seg.remotion?.template === NAME_CARD_TEMPLATE && seg.min_duration_sec === null) {
    seg = { ...seg, min_duration_sec: NAME_CARD_DEFAULT_SECONDS };
  }
  const lines = segmentLines(seg);
  if (!lines.length) return { ...seg, lines: null };
  if (!seg.lines?.length) return { ...seg, lines };
  const hasCaption = lines.some((l) => l.caption_text);
  return {
    ...seg,
    lines,
    narration: lines.map((l) => l.text.trim()).join(" "),
    tts_text: lines.some((l) => l.tts_text) ? lines.map((l) => (l.tts_text ?? l.text).trim()).join(" ") : null,
    caption_text: hasCaption ? lines.map((l) => (l.caption_text ?? l.text).trim()).join(" ") : seg.caption_text,
  };
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
  const structure = StructureSchema.parse({
    ...(story.defaults.structure ?? {}),
    ...stripUndefined((o.structure ?? {}) as Record<string, unknown>),
  });

  const rest = clone(doc);
  const idn = story.narrator.identification;
  const povId = idn?.pov_character_id ?? story.narrator.pov_character_id;
  rest.segments = rest.segments.map(normaliseLines).map((s) => {
    if (s.remotion?.template !== NAME_CARD_TEMPLATE) return s;
    const props = s.remotion.props;
    return {
      ...s,
      remotion: {
        ...s.remotion,
        props: { ...props, text: props.text?.trim() || idn?.name_card?.text || null, character_id: props.character_id ?? povId ?? null },
      },
    };
  });
  return {
    ...rest,
    voices: speakerVoices(story, voice, o.voice as { speed?: number } | undefined),
    series: {
      ...rest.series,
      series_id: story.story_id,
      series_title: story.story_title,
      total_episodes_planned: story.total_episodes_planned,
    },
    youtube: {
      ...rest.youtube,
      channel_name: rest.youtube.channel_name || story.channel.channel_name,
      playlist: rest.youtube.playlist ?? story.story_title,
    },
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
    structure,
    audio,
    render,
    crop_policy,
    story: {
      story_id: story.story_id,
      story_title: story.story_title,
      channel: clone(story.channel),
      narrator: clone(story.narrator),
      characters: clone(story.characters),
      character_groups: clone(story.character_groups),
      scene_bible: clone(story.scene_bible),
    },
  };
}

/** A stored (already expanded) bible with defaults for fields added since it was saved. */
export function upgradeStoredBible(b: unknown): StoryBible {
  const parsed = StoredStoryBibleSchema.safeParse(b);
  return (parsed.success ? parsed.data : b) as StoryBible;
}

export function isResolvedV2(ep: unknown): ep is Episode {
  return !!ep && typeof ep === "object" && "story" in ep && "crop_policy" in ep;
}
