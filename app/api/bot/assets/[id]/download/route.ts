import { eq } from "drizzle-orm";
import { presignAssetGet, verifyDownloadSig } from "@/lib/assets";
import { authenticate } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets, projects } from "@/lib/db/schema";
import type { Episode } from "@/lib/episode/schema";
import { baseUrl, clientIp, handle, HttpError, rateLimit } from "@/lib/http";

/** Redirects to a short-lived storage URL. Auth: bot bearer token, or the signed `sig` from the task payload. */
export const GET = handle(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
  rateLimit(`download:${clientIp(request)}`, 60);
  const { id } = await ctx.params;
  const sig = new URL(request.url).searchParams.get("sig");
  if (!verifyDownloadSig(id, sig)) await authenticate(request, "bot");
  const db = await getDb();
  const [asset] = await db.select().from(assets).where(eq(assets.id, id));
  if (!asset || asset.status !== "ready") throw new HttpError(404, "Asset not found or no longer current.");
  const [project] = asset.projectId ? await db.select().from(projects).where(eq(projects.id, asset.projectId)) : [];
  const ep = project?.episode as Episode | undefined;
  const stem = ep ? `${ep.series.series_id}-ep${ep.series.episode_number}` : (asset.projectId ?? asset.storyId ?? "asset");
  const ext = asset.storageKey.split(".").pop();
  const name = asset.kind === "video" ? `${stem}.${ext}` : `${stem}-${asset.assetKey.replace(/\//g, "-")}.${ext}`;
  const url = await presignAssetGet(asset, baseUrl(request), name);
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
});
