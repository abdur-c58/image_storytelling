import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { HttpError, handle, json } from "@/lib/http";
import { ingestDocument } from "@/lib/pipeline/ingest";

const MAX_BYTES = 1_000_000;

/**
 * Store a story bible, episode or bundle (admin session). The body is the JSON text itself so validation
 * errors carry line/column numbers. Requiring application/json forces a CORS preflight, which keeps
 * cross-site form posts from riding the admin cookie.
 */
export const POST = handle(async (request: Request) => {
  await requireAdmin();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send the JSON with Content-Type: application/json.");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) throw new HttpError(413, "JSON is too large.");
  const text = await request.text();
  if (text.length > MAX_BYTES) throw new HttpError(413, "JSON is too large.");
  const out = await ingestDocument(await getDb(), text);
  const { validation } = out;
  if (out.error) {
    return json(
      { error: out.error, doc_type: out.docType, errors: validation.errors, warnings: validation.warnings },
      { status: validation.ok ? 409 : 422 },
    );
  }
  return json(
    {
      id: out.projectId,
      project_id: out.projectId,
      story_id: out.storyId,
      episode_number: validation.episode?.series.episode_number ?? null,
      version: out.version,
      replaced: out.replaced,
      bible: out.bible,
      doc_type: out.docType,
      warnings: validation.warnings,
    },
    { status: 201 },
  );
});
