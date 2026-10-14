import { eq } from "drizzle-orm";
import { readyStoryAssets } from "@/lib/assets";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { storyMasters } from "@/lib/db/schema";
import { HttpError, handle, json } from "@/lib/http";
import { listEpisodes } from "@/lib/pipeline/folders";
import { computeStoryState } from "@/lib/pipeline/snapshots";
import { approveAllGenerated, effectiveBible, getStory, requestVoiceSample } from "@/lib/pipeline/story";

/** Story folder status for scripts (admin session): state, episodes, story_state, master statuses and voice tests. */
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
  const voiceSamples = (await readyStoryAssets(db, id))
    .filter((a) => a.assetKey.startsWith("voice_sample/"))
    .map((a) => ({ speaker: a.assetKey.slice("voice_sample/".length), duration_sec: a.durationSec, created_at: a.createdAt }));
  const episodes = (await listEpisodes(db, id)).map((e) => ({
    episode_number: e.number,
    episode_title: e.title,
    versions: e.versions,
    active_version: e.active ? { project_id: e.active.id, version: e.active.version, state: e.active.state, needs_revalidation: e.active.needsRevalidation } : null,
    status: e.bucket,
  }));
  return json({
    id: story.id,
    title: story.title,
    description: story.description,
    status: story.status,
    state: story.state,
    state_detail: story.stateDetail,
    episodes,
    story_state: story.bible ? await computeStoryState(db, id, effectiveBible(story)) : null,
    masters,
    voice_samples: voiceSamples,
  });
});

/**
 * `{"action": "approve_all_masters"}` approves the newest candidate of every generated master.
 * `{"action": "test_voice", "speaker": "<narrator|character id>", "text"?: "..."}` queues a voice test.
 */
export const POST = handle(async (request: Request, ctx: RouteContext<"/api/stories/[id]">) => {
  await requireAdmin();
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  }
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { action?: string; speaker?: unknown; text?: unknown } | null;
  const db = await getDb();
  if (!(await getStory(db, id))) throw new HttpError(404, "Story not found.");
  if (body?.action === "approve_all_masters") return json({ approved: await approveAllGenerated(db, id) });
  if (body?.action === "test_voice") {
    if (typeof body.speaker !== "string" || !body.speaker) throw new HttpError(400, '"speaker" is required.');
    try {
      await requestVoiceSample(db, id, body.speaker, typeof body.text === "string" ? body.text : undefined);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return json({ queued: true });
  }
  throw new HttpError(400, 'Unknown action; use "approve_all_masters" or "test_voice".');
});
