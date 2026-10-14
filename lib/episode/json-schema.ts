import { z } from "zod";
import { BundleSchema, EpisodeDocSchema, StoryBibleSchema } from "./schema";

const DOCS = {
  story_bible: {
    schema: StoryBibleSchema,
    title: "Story bible (schema 2.0)",
    description:
      "One per story: channel, style, characters with outfits, locations with states/angles/props, world variables, voice/audio/render/crop defaults. Cross-field rules (unique ids, base states, enum values) are enforced by the site's validator; see docs/CLAUDE_SCRIPT_CONTRACT.md.",
  },
  episode: {
    schema: EpisodeDocSchema,
    title: "Episode (schema 2.0)",
    description:
      "One episode of a stored story (story_id). Continuity (scene states, world variables, outfits, first appearances), bible_additions, tts_text tags and YouTube limits are enforced by the site's validator; see docs/CLAUDE_SCRIPT_CONTRACT.md.",
  },
  bundle: {
    schema: BundleSchema,
    title: "Story bible + episode bundle (schema 2.0)",
    description: "A story bible and one episode in a single document. Validated exactly like the two separately.",
  },
} as const;

export type SchemaDocType = keyof typeof DOCS;
export const SCHEMA_DOC_TYPES = Object.keys(DOCS) as SchemaDocType[];

export function documentJsonSchema(docType: SchemaDocType) {
  const d = DOCS[docType];
  const jsonSchema = z.toJSONSchema(d.schema, { io: "input", target: "draft-2020-12", unrepresentable: "any" });
  return {
    $id: `https://slideshow-storytelling.local/schema/${docType}.schema.json`,
    title: d.title,
    description: d.description,
    ...jsonSchema,
  };
}
