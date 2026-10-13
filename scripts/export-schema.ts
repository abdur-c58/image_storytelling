import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { episodeJsonSchema } from "../lib/episode/json-schema";

const outDir = path.resolve(__dirname, "..", "schema");
mkdirSync(outDir, { recursive: true });

const target = path.join(outDir, "episode.schema.json");
writeFileSync(target, JSON.stringify(episodeJsonSchema(), null, 2) + "\n", "utf8");
console.log(`Wrote ${path.relative(process.cwd(), target)}`);
