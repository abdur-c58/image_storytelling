import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { PageHeader } from "../ui";

export default async function SeriesListPage() {
  const db = await getDb();
  const rows = await db
    .select({
      seriesId: projects.seriesId,
      episodes: sql<number>`count(*)::int`,
      latest: sql<number>`max(${projects.episodeNumber})::int`,
      published: sql<number>`count(${projects.publishedAt})::int`,
    })
    .from(projects)
    .where(eq(projects.archived, false))
    .groupBy(projects.seriesId)
    .orderBy(desc(sql`max(${projects.updatedAt})`));
  return (
    <>
      <PageHeader eyebrow="Continuity" title="Series" />
      {rows.length === 0 && (
        <div className="dot-grid rounded-2xl border border-line py-20 text-center font-light text-muted">No series yet.</div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((s) => (
          <Link
            key={s.seriesId}
            href={`/series/${encodeURIComponent(s.seriesId)}`}
            className="card group hover:border-line-hover"
          >
            <p className="text-lg font-semibold tracking-tight">{s.seriesId}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="chip">{s.episodes} episodes</span>
              <span className="chip">latest #{s.latest}</span>
              <span className="chip">{s.published} published</span>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
