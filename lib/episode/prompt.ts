import { baseStateId, defaultOutfitId, masterKeyForOutfit, masterKeyForView, variableApplies } from "./continuity";
import type { Episode, Location, Segment, StoryBible, StoryCharacter } from "./schema";

export interface PromptPart {
  /** style | anchor | state | angle | world | character | props | cameo | scene */
  kind: string;
  label: string;
  text: string;
}

export interface ImageItem {
  /** Segment id, "thumbnail" for thumbnail bases, or "master" for story masters. */
  segment_id: string;
  /** Stable asset key, e.g. "image/seg_004", "thumbnail_base/0" or "master/loc/kitchen/base/a". */
  asset_key: string;
  final_prompt: string;
  negative_prompt: string;
  /** Labelled pieces final_prompt was built from, for the prompt inspector. */
  prompt_parts: PromptPart[];
  /** Story masters this image must match; their approved images are sent as references. */
  master_keys: string[];
  reference_image_ids: string[];
  reference_image_urls: string[];
  aspect_ratio: string;
  output_filename: string;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Kept on one line: the bot pastes it into a single text box, where a newline may submit.
 */
export function joinParts(parts: PromptPart[]): string {
  return parts
    .map((p) => sentence(p.text))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

export function assembleNegative(episode: Pick<Episode, "style_bible">, extra = ""): string {
  return [episode.style_bible.negative_prompt, extra]
    .map((p) => p.trim().replace(/[,\s]+$/, ""))
    .filter(Boolean)
    .join(", ");
}

function outputName(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? key);
}

type SceneBible = StoryBible["scene_bible"];

export function locationParts(loc: Location, stateId: string, angleId: string): PromptPart[] {
  const state = loc.states.find((s) => s.id === stateId);
  const angle = loc.camera_angles.find((a) => a.id === angleId);
  const parts: PromptPart[] = [
    { kind: "anchor", label: `Location: ${loc.name}`, text: `Location, ${loc.name}: ${loc.anchor_description}` },
  ];
  if (loc.fixed_landmarks.length) {
    parts.push({ kind: "anchor", label: "Fixed landmarks", text: `Always visible and unchanged: ${loc.fixed_landmarks.join("; ")}` });
  }
  if (state?.description) parts.push({ kind: "state", label: `State: ${state.id}`, text: `Current state: ${state.description}` });
  if (angle) parts.push({ kind: "angle", label: `Angle: ${angle.id}`, text: `Camera: ${angle.prompt}` });
  return parts;
}

export function worldParts(sceneBible: SceneBible, loc: Location | undefined, world: Record<string, number | string>): PromptPart[] {
  return sceneBible.world_variables
    .filter((v) => v.prompt_template && variableApplies(v, loc) && world[v.id] !== undefined)
    .map((v) => ({ kind: "world", label: `${v.id} = ${world[v.id]}`, text: v.prompt_template.replaceAll("{value}", String(world[v.id])) }));
}

function characterPart(c: StoryCharacter, outfitId: string, pose: string, position: string): PromptPart {
  const outfit = c.outfit_states.find((o) => o.id === outfitId);
  const bits = [`${c.name}: ${c.visual_description}`];
  if (outfit?.description) bits.push(`wearing ${outfit.description}`);
  if (pose) bits.push(pose);
  if (position) bits.push(position === "background" ? "in the background" : `${position} of frame`);
  return { kind: "character", label: `${c.id} (${outfitId})`, text: bits.join("; ") };
}

/** Per-segment scene context: where the story stands when each segment is shown. */
export interface SegmentScene {
  location: Location;
  state_id: string;
  camera_angle_id: string;
  world: Record<string, number | string>;
  characters: { character: StoryCharacter; outfit_state_id: string; pose: string; position: string }[];
  props: string[];
  cameo: boolean;
}

export function segmentScenes(
  episode: Episode,
  start: { world: Record<string, number | string>; outfits: Record<string, string> } | undefined = episode.story.start_state,
): Map<string, SegmentScene> {
  const sb = episode.story.scene_bible;
  const locations = new Map(sb.locations.map((l) => [l.id, l]));
  const chars = new Map(episode.story.characters.map((c) => [c.id, c]));
  const world: Record<string, number | string> = {
    ...Object.fromEntries(sb.world_variables.map((v) => [v.id, v.initial])),
    ...(start?.world ?? {}),
  };
  const outfits: Record<string, string> = {
    ...Object.fromEntries(episode.story.characters.map((c) => [c.id, defaultOutfitId(c)])),
    ...(start?.outfits ?? {}),
  };
  const out = new Map<string, SegmentScene>();
  for (const seg of [...episode.segments].sort((a, b) => a.order - b.order)) {
    const scene = seg.scene;
    if (!scene) continue;
    Object.assign(world, scene.world_state);
    const loc = locations.get(scene.location_id);
    if (!loc) continue;
    const present = scene.characters_present.flatMap((cp) => {
      const c = chars.get(cp.character_id);
      if (!c) return [];
      if (cp.outfit_state_id) outfits[c.id] = cp.outfit_state_id;
      return [{ character: c, outfit_state_id: outfits[c.id] ?? defaultOutfitId(c), pose: cp.pose_or_action, position: cp.position_in_frame }];
    });
    out.set(seg.id, {
      location: loc,
      state_id: scene.state_id,
      camera_angle_id: scene.camera_angle_id,
      world: { ...world },
      characters: present,
      props: scene.props_in_frame,
      cameo: scene.include_channel_cameo,
    });
  }
  return out;
}

/**
 * final_prompt = style + location anchor + state + angle + world variables + characters (visual, outfit, pose)
 * + props + channel cameo + image.prompt.
 */
export function scenePromptParts(episode: Episode, ctx: SegmentScene | null, scenePrompt: string): PromptPart[] {
  const parts: PromptPart[] = [{ kind: "style", label: "Style", text: episode.style_bible.global_style_prompt }];
  if (ctx) {
    parts.push(...locationParts(ctx.location, ctx.state_id, ctx.camera_angle_id));
    parts.push(...worldParts(episode.story.scene_bible, ctx.location, ctx.world));
    for (const c of ctx.characters) parts.push(characterPart(c.character, c.outfit_state_id, c.pose, c.position));
    const props = ctx.props
      .map((id) => ctx.location.key_props.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => (p.default_position ? `${p.description} (${p.default_position})` : p.description));
    if (props.length) parts.push({ kind: "props", label: "Props", text: `Props in frame: ${props.join("; ")}` });
    const cameo = episode.story.channel.recurring_cameo;
    if (ctx.cameo && cameo) parts.push({ kind: "cameo", label: "Channel cameo", text: `Somewhere in frame: ${cameo.description}` });
  }
  if (scenePrompt.trim()) parts.push({ kind: "scene", label: "Scene", text: `Scene: ${scenePrompt}` });
  return parts;
}

function legacyReferences(episode: Episode, characterIds: string[]): { ids: string[]; urls: string[] } {
  const byId = new Map(episode.style_bible.characters.map((c) => [c.id, c]));
  const ids = new Set<string>();
  for (const cid of characterIds) for (const rid of byId.get(cid)?.reference_image_ids ?? []) ids.add(rid);
  const assets = new Map(episode.style_bible.reference_assets.map((r) => [r.id, r]));
  const urls = [...ids].map((id) => assets.get(id)?.asset_url_or_path ?? "").filter((u) => /^https?:\/\//i.test(u));
  return { ids: [...ids], urls };
}

export function segmentNeedsGeneratedImage(segment: Segment): boolean {
  if (segment.type === "illustration") return true;
  if (segment.type === "title_card" || segment.type === "infographic") {
    return segment.remotion?.props.background === "image" && !segment.remotion.props.background_image_segment_id && !!segment.image?.prompt.trim();
  }
  return false;
}

export function masterKeysFor(ctx: SegmentScene | null): string[] {
  if (!ctx) return [];
  return [
    masterKeyForView({ location_id: ctx.location.id, state_id: ctx.state_id, camera_angle_id: ctx.camera_angle_id }),
    ...ctx.characters.map((c) => masterKeyForOutfit({ character_id: c.character.id, outfit_state_id: c.outfit_state_id })),
  ];
}

export function buildSegmentImageItem(episode: Episode, segment: Segment, scenes = segmentScenes(episode)): ImageItem {
  const image = segment.image!;
  const trigger = episode.automation.bot_triggers.find((t) => t.trigger_id === "generate_images");
  const ctx = scenes.get(segment.id) ?? null;
  const parts = scenePromptParts(episode, ctx, image.prompt);
  const refs = legacyReferences(episode, ctx?.characters.map((c) => c.character.id) ?? []);
  return {
    segment_id: segment.id,
    asset_key: `image/${segment.id}`,
    final_prompt: joinParts(parts),
    negative_prompt: assembleNegative(episode, image.negative_prompt_extra),
    prompt_parts: parts,
    master_keys: masterKeysFor(ctx),
    reference_image_ids: refs.ids,
    reference_image_urls: refs.urls,
    aspect_ratio: episode.style_bible.aspect_ratio,
    output_filename: outputName(trigger?.output_naming ?? "{segment_id}.png", { segment_id: segment.id }),
  };
}

export function buildImageItems(episode: Episode): ImageItem[] {
  const scenes = segmentScenes(episode);
  return [...episode.segments]
    .sort((a, b) => a.order - b.order)
    .filter(segmentNeedsGeneratedImage)
    .map((segment) => buildSegmentImageItem(episode, segment, scenes));
}

export function buildThumbnailItems(episode: Episode): ImageItem[] {
  const trigger = episode.automation.bot_triggers.find((t) => t.trigger_id === "generate_thumbnail_base");
  const th = episode.thumbnail;
  const loc = th.scene ? episode.story.scene_bible.locations.find((l) => l.id === th.scene!.location_id) : undefined;
  const chars = new Map(episode.story.characters.map((c) => [c.id, c]));
  const ctx: SegmentScene | null =
    th.scene && loc
      ? {
          location: loc,
          state_id: th.scene.state_id,
          camera_angle_id: th.scene.camera_angle_id,
          world: th.scene.world_state,
          characters: th.characters_present.flatMap((id) => {
            const c = chars.get(id);
            return c ? [{ character: c, outfit_state_id: defaultOutfitId(c), pose: "", position: "" }] : [];
          }),
          props: [],
          cameo: false,
        }
      : null;
  const parts = ctx
    ? scenePromptParts(episode, ctx, th.image_prompt)
    : [
        { kind: "style", label: "Style", text: episode.style_bible.global_style_prompt },
        ...th.characters_present.flatMap((id) => {
          const c = chars.get(id);
          return c ? [characterPart(c, defaultOutfitId(c), "", "")] : [];
        }),
        { kind: "scene", label: "Scene", text: `Scene: ${th.image_prompt}` },
      ];
  const refs = legacyReferences(episode, th.characters_present);
  const items: ImageItem[] = [];
  for (let variant = 0; variant <= th.alt_variants; variant++) {
    items.push({
      segment_id: "thumbnail",
      asset_key: `thumbnail_base/${variant}`,
      final_prompt: joinParts(parts),
      negative_prompt: assembleNegative(episode, "text, letters, watermark"),
      prompt_parts: parts,
      master_keys: masterKeysFor(ctx),
      reference_image_ids: refs.ids,
      reference_image_urls: refs.urls,
      aspect_ratio: "16:9",
      output_filename: outputName(trigger?.output_naming ?? "thumbnail_base_{variant}.png", { variant: String(variant) }),
    });
  }
  return items;
}

// ── Story masters ───────────────────────────────────────────────────────────

export interface MasterItem {
  master_key: string;
  kind: "location" | "character";
  label: string;
  final_prompt: string;
  negative_prompt: string;
  prompt_parts: PromptPart[];
  /** What the bot checks before uploading (landmarks / character description). */
  must_match: string[];
  output_filename: string;
}

/** Empty location plates per (location, state, angle) and reference sheets per (character, outfit). */
export function buildMasterItems(bible: StoryBible): MasterItem[] {
  const style: PromptPart = { kind: "style", label: "Style", text: bible.style_bible.global_style_prompt };
  const items: MasterItem[] = [];
  for (const loc of bible.scene_bible.locations) {
    for (const state of loc.states) {
      for (const angle of loc.camera_angles) {
        const key = masterKeyForView({ location_id: loc.id, state_id: state.id, camera_angle_id: angle.id });
        const props = loc.key_props.map((p) => (p.default_position ? `${p.description} (${p.default_position})` : p.description));
        const parts: PromptPart[] = [
          style,
          ...locationParts(loc, state.id, angle.id),
          ...(props.length ? [{ kind: "props", label: "Props", text: `Props in their usual places: ${props.join("; ")}` }] : []),
          { kind: "scene", label: "Master", text: "Establishing plate of the empty location: no people, no animals, no characters, nothing moving" },
        ];
        items.push({
          master_key: key,
          kind: "location",
          label: `${loc.name} · ${state.id}${state.id === baseStateId(loc) ? " (base)" : ""} · ${angle.name || angle.id}`,
          final_prompt: joinParts(parts),
          negative_prompt: [bible.style_bible.negative_prompt, "people, person, character, figure, crowd, text, watermark"].filter(Boolean).join(", "),
          prompt_parts: parts,
          must_match: [loc.anchor_description, ...loc.fixed_landmarks],
          output_filename: `${key.replaceAll("/", "__")}.png`,
        });
      }
    }
  }
  for (const c of bible.characters) {
    const outfits = c.outfit_states.length ? c.outfit_states : [{ id: defaultOutfitId(c), description: "" }];
    for (const o of outfits) {
      const key = masterKeyForOutfit({ character_id: c.id, outfit_state_id: o.id });
      const parts: PromptPart[] = [
        style,
        characterPart(c, o.id, "", ""),
        { kind: "scene", label: "Master", text: "Character reference sheet: the same person shown front, three-quarter and side, full body, plain neutral background" },
      ];
      items.push({
        master_key: key,
        kind: "character",
        label: `${c.name} · ${o.id}`,
        final_prompt: joinParts(parts),
        negative_prompt: [bible.style_bible.negative_prompt, "text, labels, watermark, multiple different people"].filter(Boolean).join(", "),
        prompt_parts: parts,
        must_match: [c.visual_description, ...(o.description ? [o.description] : [])],
        output_filename: `${key.replaceAll("/", "__")}.png`,
      });
    }
  }
  return items;
}

/** Segment whose generated picture a segment displays (follows reuse chains). */
export function pictureSourceSegmentId(episode: Pick<Episode, "segments">, segment: Segment): string | null {
  const byId = new Map(episode.segments.map((s) => [s.id, s]));
  let current: Segment | undefined = segment;
  for (let hops = 0; current && hops < episode.segments.length; hops++) {
    if (current.type === "reuse_image") {
      current = byId.get(current.image?.reuse_from_segment_id ?? "");
      continue;
    }
    if (current.type === "title_card" || current.type === "infographic") {
      const bg = current.remotion?.props.background_image_segment_id;
      if (current.remotion?.props.background !== "image") return null;
      if (bg) {
        current = byId.get(bg);
        continue;
      }
    }
    return current.id;
  }
  return null;
}
