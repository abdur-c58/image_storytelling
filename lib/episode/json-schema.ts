import { z } from "zod";
import { BundleSchema, EpisodeDocSchema, StoryBibleSchema } from "./schema";

const DOCS = {
  story_bible: {
    schema: StoryBibleSchema,
    title: "Story bible (schema 2.3)",
    description:
      "One per story folder: channel, style, characters with outfits, locations with states/angles/props, world variables, voice/audio/render/crop defaults. Cross-field rules (unique ids, base states, enum values) are enforced by the site's validator; see docs/CLAUDE_SCRIPT_CONTRACT.md.",
  },
  episode: {
    schema: EpisodeDocSchema,
    title: "Episode (schema 2.3)",
    description:
      "One episode of a stored story. The header (story_id, episode_number, episode_title) files it into its story folder. Continuity (scene states, world variables, outfits, first appearances), bible_additions, tts_text tags and YouTube limits are enforced by the site's validator; see docs/CLAUDE_SCRIPT_CONTRACT.md.",
  },
  bundle: {
    schema: BundleSchema,
    title: "Story bible + episode bundle (schema 2.3)",
    description: "A story bible and one episode in a single document. Validated exactly like the two separately.",
  },
} as const;

export type SchemaDocType = keyof typeof DOCS;
export const SCHEMA_DOC_TYPES = Object.keys(DOCS) as SchemaDocType[];

type JsonObj = { [k: string]: unknown; required?: string[]; properties?: Record<string, JsonObj> };

/**
 * The validator fills `series` and `youtube.title` from the 2.3 header (lib/episode/header.ts), so a 2.3 file may
 * leave them out; the exported schema describes the file as written.
 */
function relaxEpisode(ep: JsonObj | undefined) {
  if (!ep?.properties) return;
  ep.required = [...(ep.required ?? []).filter((r) => r !== "series"), "episode_number", "episode_title"];
  const series = ep.properties.series;
  if (series) series.required = (series.required ?? []).filter((r) => r !== "episode_number" && r !== "episode_title_short");
  const youtube = ep.properties.youtube;
  if (youtube) youtube.required = (youtube.required ?? []).filter((r) => r !== "title");
}

export function documentJsonSchema(docType: SchemaDocType) {
  const d = DOCS[docType];
  const jsonSchema = z.toJSONSchema(d.schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" }) as JsonObj;
  if (docType === "episode") relaxEpisode(jsonSchema);
  if (docType === "bundle") relaxEpisode(jsonSchema.properties?.episode);
  return {
    $id: `https://slideshow-storytelling.local/schema/${docType}.schema.json`,
    title: d.title,
    description: d.description,
    ...jsonSchema,
  };
}
