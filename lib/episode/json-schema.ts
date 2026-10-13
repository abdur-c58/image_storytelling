import { z } from "zod";
import { EpisodeObjectSchema } from "./schema";

export function episodeJsonSchema() {
  const jsonSchema = z.toJSONSchema(EpisodeObjectSchema, { io: "input", target: "draft-2020-12", unrepresentable: "any" });
  return {
    $id: "https://slideshow-storytelling.local/schema/episode.schema.json",
    title: "Illustrated-story episode script",
    description:
      "Contract for one episode. Cross-field rules (unique ids, contiguous order, reuse targets, at_phrase, YouTube limits) are enforced by the site's validator; see docs/CLAUDE_SCRIPT_CONTRACT.md.",
    ...jsonSchema,
  };
}
