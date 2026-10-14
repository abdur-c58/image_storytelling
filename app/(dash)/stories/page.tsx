import { desc, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { projects, stories, storyMasters } from "@/lib/db/schema";
import { ago, PageHeader, StateBadge } from "../ui";

export default async function StoriesPage() {
  const db = await getDb();
  const [rows, episodeCounts, masterCounts] = await Promise.all([
    db.select().from(stories).orderBy(desc(stories.updatedAt)),
    db
      .select({ storyId: projects.storyId, n: sql<number>`count(*)::int` })
      .from(projects)
      .where(sql`${projects.storyId} is not null and ${projects.archived} = false`)
      .groupBy(projects.storyId),
    db
      .select({
        storyId: storyMasters.storyId,
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${storyMasters.status} = 'approved')::int`,
      })
      .from(storyMasters)
      .groupBy(storyMasters.storyId),
  ]);
  const episodes = new Map(episodeCounts.map((r) => [r.storyId, r.n]));
  const masters = new Map(masterCounts.map((r) => [r.storyId, r]));
  return (
    <>
      <PageHeader eyebrow="Continuity" title="Stories">
        <Link href="/new" className="btn">
          New story or episode
        </Link>
      </PageHeader>
      {rows.length === 0 && (
        <div className="dot-grid rounded-2xl border border-line py-20 text-center font-light text-muted">
          No stories yet. Paste a story bible on the New page.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((s) => {
          const m = masters.get(s.id);
          return (
            <Link key={s.id} href={`/stories/${encodeURIComponent(s.id)}`} className="card group flex flex-col gap-3 hover:border-line-hover">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold tracking-tight">{s.title}</p>
                  <p className="font-mono text-xs text-muted">{s.id}</p>
                </div>
                <StateBadge state={s.state} />
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="chip">{episodes.get(s.id) ?? 0} episodes</span>
                {m && (
                  <span className="chip">
                    masters {m.approved}/{m.total}
                  </span>
                )}
                <span className="chip">updated {ago(s.updatedAt)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
