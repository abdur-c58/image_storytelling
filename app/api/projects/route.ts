import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { validateEpisodeText } from "@/lib/episode/validate";
import { HttpError, handle, json } from "@/lib/http";
import { createProject } from "@/lib/pipeline/project";

const MAX_BYTES = 1_000_000;

/**
 * Create a project from raw episode JSON (admin session). The body is the episode text itself so
 * validation errors carry line/column numbers. Requiring application/json forces a CORS preflight,
 * which keeps cross-site form posts from riding the admin cookie.
 */
export const POST = handle(async (request: Request) => {
  await requireAdmin();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send the episode JSON with Content-Type: application/json.");
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) throw new HttpError(413, "Episode JSON is too large.");
  const text = await request.text();
  if (text.length > MAX_BYTES) throw new HttpError(413, "Episode JSON is too large.");
  const result = validateEpisodeText(text);
  if (!result.ok) return json({ error: "Episode JSON has errors.", errors: result.errors, warnings: result.warnings }, { status: 422 });
  const id = await createProject(await getDb(), text, result);
  return json({ id, warnings: result.warnings }, { status: 201 });
});
