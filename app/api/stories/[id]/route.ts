import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { storyMasters } from "@/lib/db/schema";
import { HttpError, handle, json } from "@/lib/http";
import { approveAllGenerated, getStory } from "@/lib/pipeline/story";

/** Story status for scripts (admin session): state, story_state and master statuses. */
export const GET = handle(async (_request: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const db = await getDb();
  const story = await getStory(db, id);
  if (!story) throw new HttpError(404, "Story not found.");
  const masters = await db
    .select({ master_key: storyMasters.masterKey, status: storyMasters.status })
    .from(storyMasters)
    .where(eq(storyMasters.storyId, id));
  return json({
    id: story.id,
    title: story.title,
    state: story.state,
    state_detail: story.stateDetail,
    story_state: story.storyState,
    masters,
  });
});

/** `{"action": "approve_all_masters"}` approves the newest candidate of every generated master. */
export const POST = handle(async (request: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  await requireAdmin();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  }
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "approve_all_masters") throw new HttpError(400, 'Unknown action; use "approve_all_masters".');
  const db = await getDb();
  if (!(await getStory(db, id))) throw new HttpError(404, "Story not found.");
  return json({ approved: await approveAllGenerated(db, id) });
});
