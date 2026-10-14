import { SCHEMA_VERSION } from "./constants";
import { stripTags } from "./tags";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface MigrationResult {
  bundle: Json;
  notes: string[];
}

/**
 * Convert a schema 1.0 episode into a 2.0 bundle. v1 has no scene model, so every illustration gets one
 * placeholder location ("main", state "base", angle "a"); masters are switched off so nothing waits on them.
 * The result validates, but the placeholder location should be described before the next episode.
 */
export function convertV1ToV2(v1: unknown): MigrationResult {
  const ep = obj(v1);
  const notes: string[] = [];
  const series = obj(ep.series);
  const style = obj(ep.style_bible);
  const youtube = obj(ep.youtube);
  const storyId = str(series.series_id) || "story";

  const characters = arr(style.characters).map((c) => {
    const ch = obj(c);
    return {
      id: ch.id,
      name: ch.name,
      role: "extra",
      visual_description: ch.visual_description,
      outfit_states: [],
      reference_image_ids: arr(ch.reference_image_ids),
      first_appears_episode: 1,
    };
  });
  const { characters: _c, ...styleRest } = style;
  void _c;

  const storyBible: Json = {
    schema_version: SCHEMA_VERSION,
    doc_type: "story_bible",
    story_id: storyId,
    story_title: str(series.series_title) || storyId,
    total_episodes_planned: series.total_episodes_planned ?? null,
    channel: { channel_name: str(youtube.channel_name) || "Channel", recurring_cameo: null },
    style_bible: styleRest,
    characters,
    scene_bible: {
      world_variables: [],
      locations: [
        {
          id: "main",
          name: "Main setting",
          tags: [],
          anchor_description: "The story's main setting (converted from schema 1.0; describe it before the next episode).",
          fixed_landmarks: [],
          camera_angles: [{ id: "a", name: "Default", prompt: "wide shot" }],
          states: [{ id: "base", description: "", is_base: true }],
          key_props: [],
        },
      ],
    },
    defaults: {
      voice: { ...obj(ep.voice), tag_fallback_mode: "none" },
      audio: obj(ep.audio),
      render: obj(ep.render),
      crop_policy: { enabled: false },
    },
    automation: { approval_gates: { location_masters: false }, bot_triggers: [] },
  };
  notes.push('Added one placeholder location "main" (state "base", angle "a"); describe it in the story bible.');
  notes.push("Location masters are off (approval_gates.location_masters = false) and the crop engine is off; turn them on when the scene bible is filled in.");
  if (style.characters && arr(style.characters).length) {
    notes.push("Characters moved from style_bible.characters to the top-level characters list.");
  }

  let movedTags = 0;
  let droppedMotion = 0;
  const segments = arr(ep.segments).map((s) => {
    const seg = { ...obj(s) };
    const image = seg.image ? { ...obj(seg.image) } : null;
    const narration = str(seg.narration);
    if (/[[\]]|<\/?[a-z]/i.test(narration)) {
      seg.tts_text = seg.tts_text ?? narration;
      seg.narration = stripTags(narration);
      movedTags++;
    }
    if (image) {
      const extra = [
        str(image.shot_type) && `${str(image.shot_type)} shot`,
        str(image.mood) && `mood: ${str(image.mood)}`,
        str(image.time_of_day) && `time of day: ${str(image.time_of_day)}`,
      ].filter(Boolean);
      if (extra.length) image.prompt = `${str(image.prompt).trim().replace(/\.$/, "")}. ${extra.join("; ")}`;
      if (image.motion && image.motion !== "none") droppedMotion++;
      const present = arr(image.characters_present);
      for (const k of ["motion", "shot_type", "mood", "time_of_day", "characters_present"]) delete image[k];
      if (seg.type === "illustration") {
        seg.scene = {
          location_id: "main",
          state_id: "base",
          camera_angle_id: "a",
          world_state: {},
          characters_present: present.map((id) => ({ character_id: id })),
          props_in_frame: [],
          state_changes: [],
        };
      }
      seg.image = image;
    }
    return seg;
  });
  if (movedTags) notes.push(`${movedTags} narration(s) contained tags; they were moved to tts_text and narration was cleaned.`);
  if (droppedMotion) notes.push(`${droppedMotion} image.motion value(s) were dropped; the crop engine replaces motion.`);

  const { series_id: _sid, series_title: _st, total_episodes_planned: _tep, ...seriesRest } = series;
  void _sid;
  void _st;
  void _tep;
  const episode: Json = {
    schema_version: SCHEMA_VERSION,
    doc_type: "episode",
    story_id: storyId,
    story_title: str(series.series_title) || storyId,
    episode_number: series.episode_number,
    episode_title: str(series.episode_title_short) || str(obj(ep.youtube).title) || `Episode ${String(series.episode_number)}`,
    series: { ...seriesRest, state_carryover: obj(series.state_carryover) },
    segments,
    thumbnail: ep.thumbnail,
    youtube: ep.youtube,
    chapters: ep.chapters ?? [],
    automation: ep.automation ?? {},
    overrides: {},
    bible_additions: {},
  };
  return { bundle: { schema_version: SCHEMA_VERSION, doc_type: "bundle", story_bible: storyBible, episode }, notes };
}
