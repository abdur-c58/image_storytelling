import { documentJsonSchema, SCHEMA_DOC_TYPES, type SchemaDocType } from "@/lib/episode/json-schema";

export function GET(request: Request) {
  const type = new URL(request.url).searchParams.get("type") ?? "episode";
  if (!SCHEMA_DOC_TYPES.includes(type as SchemaDocType)) {
    return Response.json({ error: `type must be one of: ${SCHEMA_DOC_TYPES.join(", ")}` }, { status: 400 });
  }
  return Response.json(documentJsonSchema(type as SchemaDocType), { headers: { "cache-control": "public, max-age=300" } });
}
