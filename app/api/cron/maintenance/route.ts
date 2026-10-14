import { and, eq, inArray, lt } from "drizzle-orm";
import { safeEqual } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { assets, projects } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { handle, HttpError, json } from "@/lib/http";
import { advanceOwner } from "@/lib/agent-api";
import { reapExpired } from "@/lib/queue";
import { getStorage } from "@/lib/storage";

/** Intermediate files that can be rebuilt; finals (video, thumbnails, images, mix report) are kept. */
const INTERMEDIATE_KINDS = ["voice", "sfx", "mix", "timeline", "card"];

/** Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. */
export const GET = handle(async (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  if (!env.cronSecret || !safeEqual(header, `Bearer ${env.cronSecret}`)) throw new HttpError(401, "Unauthorized.");
  const db = await getDb();
  const touched = await reapExpired(db);
  for (const owner of touched) await advanceOwner(db, owner);

  const cutoff = new Date(Date.now() - env.retentionDays * 24 * 3600 * 1000);
  const finished = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.state, "PUBLISHED"), lt(projects.updatedAt, cutoff)));
  const storage = getStorage();
  let deleted = 0;
  if (finished.length) {
    const stale = await db
      .select()
      .from(assets)
      .where(and(inArray(assets.projectId, finished.map((p) => p.id)), inArray(assets.kind, INTERMEDIATE_KINDS)));
    for (const asset of stale.slice(0, 500)) {
      await storage.delete(asset.storageKey);
      await db.delete(assets).where(eq(assets.id, asset.id));
      deleted++;
    }
  }
  const superseded = await db
    .select()
    .from(assets)
    .where(and(inArray(assets.status, ["superseded", "rejected"]), lt(assets.createdAt, cutoff)))
    .limit(500);
  for (const asset of superseded) {
    await storage.delete(asset.storageKey);
    await db.delete(assets).where(eq(assets.id, asset.id));
    deleted++;
  }
  return json({ ok: true, reaped_projects: touched.length, deleted_objects: deleted });
});
