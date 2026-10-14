import type { IssuePath, IssueSink } from "./continuity";
import { CharacterSchema, type CharacterRef, type StoryBible, type StoryBibleDoc, type StoryCharacter } from "./schema";

type ReferenceAsset = StoryBible["style_bible"]["reference_assets"][number];

/** One recurring character in the channel registry (table channel_characters). */
export interface ChannelCharacterEntry {
  id: string;
  definition: StoryCharacter;
  /** The reference assets its reference_image_ids point at. */
  reference_assets: ReferenceAsset[];
  origin_story_id: string;
}

export type CastRegistry = Map<string, ChannelCharacterEntry>;

const clone = <T>(v: T): T => structuredClone(v);

/** JSON with sorted keys: stored definitions come back from jsonb with their keys reordered. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : stable(v));

export function isRef(c: StoryBibleDoc["characters"][number]): c is CharacterRef {
  return typeof (c as { ref?: unknown }).ref === "string";
}

/** What a later story may not change about a channel character, as readable differences. */
export function channelDiff(registered: StoryCharacter, given: StoryCharacter): string[] {
  const out: string[] = [];
  if (registered.visual_description.trim() !== given.visual_description.trim()) {
    out.push(`visual_description: registry ${show(registered.visual_description)} ≠ here ${show(given.visual_description)}`);
  }
  const refsA = [...registered.reference_image_ids].sort();
  const refsB = [...given.reference_image_ids].sort();
  if (stable(refsA) !== stable(refsB)) out.push(`reference_image_ids: registry ${show(refsA)} ≠ here ${show(refsB)}`);
  if (stable(registered.voice) !== stable(given.voice)) {
    out.push(`voice: registry ${show(registered.voice)} ≠ here ${show(given.voice)}`);
  }
  for (const o of given.outfit_states) {
    const known = registered.outfit_states.find((x) => x.id === o.id);
    if (known && known.description.trim() !== o.description.trim()) {
      out.push(`outfit "${o.id}": registry ${show(known.description)} ≠ here ${show(o.description)} (add a new outfit id instead)`);
    }
  }
  return out;
}

/** A full character definition checked against the registry. */
export function checkAgainstRegistry(
  c: StoryCharacter,
  registry: CastRegistry | null | undefined,
  storyId: string,
  issues: IssueSink,
  path: IssuePath,
) {
  const reg = registry?.get(c.id);
  if (!reg) return;
  if (c.scope !== "channel") {
    issues.error(path, `"${c.id}" is a channel character (from story "${reg.origin_story_id}"). Use { "ref": "${c.id}" } instead of defining it again.`);
    return;
  }
  const diff = channelDiff(reg.definition, c);
  if (!diff.length) return;
  if (reg.origin_story_id === storyId) {
    issues.warn(path, `Saving changes channel character "${c.id}" for every story that uses it: ${diff.join("; ")}.`);
    return;
  }
  issues.error(path, `Channel character "${c.id}" can't be changed by this story (only new outfit states may be added): ${diff.join("; ")}.`);
}

/**
 * Expand `{ ref }` entries from the registry and check full channel definitions against it. Without a registry
 * (the browser), refs become placeholders and are checked when the bible is saved.
 */
export function expandCast(
  doc: StoryBibleDoc,
  registry: CastRegistry | null | undefined,
  issues: IssueSink,
  prefix: IssuePath = [],
): StoryBible {
  const characters: StoryCharacter[] = [];
  const referenceAssets = clone(doc.style_bible.reference_assets);
  doc.characters.forEach((entry, i) => {
    const path = [...prefix, "characters", i];
    if (!isRef(entry)) {
      checkAgainstRegistry(entry, registry, doc.story_id, issues, path);
      characters.push(entry);
      return;
    }
    const reg = registry?.get(entry.ref);
    if (!reg) {
      if (registry) {
        issues.error([...path, "ref"], `Unknown channel character "${entry.ref}". Define it in full with "scope": "channel" the first time.`);
      } else {
        issues.warn([...path, "ref"], `"${entry.ref}" is taken from the channel cast when the story is saved.`);
      }
      characters.push(
        CharacterSchema.parse({
          id: entry.ref,
          name: entry.ref,
          scope: "channel",
          visual_description: "(channel character)",
          outfit_states: entry.story_outfit_states,
          first_appears_episode: entry.first_appears_episode,
          initial_status: entry.initial_status,
          role: entry.role,
        }),
      );
      return;
    }
    const c = clone(reg.definition);
    c.scope = "channel";
    for (const o of entry.story_outfit_states) {
      const known = c.outfit_states.find((x) => x.id === o.id);
      if (!known) c.outfit_states.push(clone(o));
      else if (known.description.trim() !== o.description.trim()) {
        issues.error([...path, "story_outfit_states"], `"${entry.ref}" already has outfit "${o.id}" (${show(known.description)}); use a new id.`);
      }
    }
    if (entry.first_appears_episode !== undefined) c.first_appears_episode = entry.first_appears_episode;
    if (entry.initial_status !== undefined) c.initial_status = entry.initial_status;
    if (entry.role !== undefined) c.role = entry.role;
    for (const a of reg.reference_assets) if (!referenceAssets.some((x) => x.id === a.id)) referenceAssets.push(clone(a));
    characters.push(c);
  });
  return { ...doc, style_bible: { ...doc.style_bible, reference_assets: referenceAssets }, characters } as StoryBible;
}
