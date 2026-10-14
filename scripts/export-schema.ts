import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { documentJsonSchema, SCHEMA_DOC_TYPES } from "../lib/episode/json-schema";

const outDir = path.resolve(__dirname, "..", "schema");
mkdirSync(outDir, { recursive: true });
rmSync(path.join(outDir, "episode.schema.json"), { force: true });

for (const docType of SCHEMA_DOC_TYPES) {
  const target = path.join(outDir, `${docType}.schema.json`);
  writeFileSync(target, JSON.stringify(documentJsonSchema(docType), null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), target)}`);
}
