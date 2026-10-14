import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { HttpError, handle } from "@/lib/http";
import { projectContext } from "@/lib/pipeline/context";

/** Download an episode version's source JSON (`kind=json`) or final description (`kind=description`), admin only. */
export const GET = handle(async (request: Request, ctx: RouteContext<"/api/projects/[id]/files">) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const kind = new URL(request.url).searchParams.get("kind");
  const db = await getDb();
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  if (!p) throw new HttpError(404, "Version not found.");
  const stem = (await projectContext(db, id)).output_basename ?? id;
  let body: string;
  let type: string;
  let name: string;
  if (kind === "json") {
    body = p.rawJson;
    type = "application/json";
    name = `${stem}.json`;
  } else if (kind === "description") {
    const d = (p.outputs as { description?: string }).description;
    if (!d) throw new HttpError(404, "The description is written after render.");
    body = d;
    type = "text/plain";
    name = `${stem}-description.txt`;
  } else {
    throw new HttpError(400, 'Use kind=json or kind=description.');
  }
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "content-disposition": `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "cache-control": "no-store",
    },
  });
});
