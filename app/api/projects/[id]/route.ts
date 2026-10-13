import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { HttpError, handle, json } from "@/lib/http";

/** Project status for scripts (admin session). */
export const GET = handle(async (_request: Request, ctx: RouteContext<"/api/projects/[id]">) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const [p] = await (await getDb()).select().from(projects).where(eq(projects.id, id));
  if (!p) throw new HttpError(404, "Project not found.");
  return json({
    id: p.id,
    title: p.title,
    state: p.state,
    state_detail: p.stateDetail,
    error: p.error,
    outputs: p.outputs,
    youtube_url: p.youtubeUrl,
    published_at: p.publishedAt,
  });
});
