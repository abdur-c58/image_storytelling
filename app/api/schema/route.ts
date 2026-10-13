import { episodeJsonSchema } from "@/lib/episode/json-schema";

export function GET() {
  return Response.json(episodeJsonSchema(), { headers: { "cache-control": "public, max-age=300" } });
}
