import { connection } from "next/server";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { ago, PageHeader, StateBadge } from "../ui";
import { DropImport } from "./drop-import";

export default async function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  await connection();
  const showArchived = (await searchParams).archived === "1";
  const db = await getDb();
  const [rows, active] = await Promise.all([
    db.select().from(projects).where(eq(projects.archived, showArchived)).orderBy(desc(projects.updatedAt)).limit(200),
    showArchived
      ? db.select({ id: projects.id, seriesId: projects.seriesId, episodeNumber: projects.episodeNumber, title: projects.title }).from(projects).where(eq(projects.archived, false))
      : null,
  ]);
  const existing = (active ?? rows).map((p) => ({ id: p.id, seriesId: p.seriesId, episodeNumber: p.episodeNumber, title: p.title }));
  return (
    <>
      <PageHeader eyebrow="Dashboard" title={showArchived ? "Archived projects" : "Projects"}>
        <Link href={showArchived ? "/projects" : "/projects?archived=1"} className="btn">
          {showArchived ? "Active projects" : "Archived"}
        </Link>
        <Link href="/new" className="btn-primary">
          New episode
        </Link>
      </PageHeader>
      <DropImport existing={existing}>
        {rows.length === 0 && showArchived ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-line py-16 text-center">
            <p className="text-xl font-semibold tracking-tight">Nothing archived</p>
            <p className="text-sm font-light text-muted">Archived projects show up here, where you can open or delete them.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="dot-grid flex flex-col items-center justify-center gap-2 rounded-2xl border border-line py-24 text-center">
            <p className="text-xl font-semibold tracking-tight">No projects yet</p>
            <p className="max-w-sm text-sm font-light text-muted">
              Drop an episode JSON here, or paste one on the{" "}
              <Link href="/new" className="link">
                New episode
              </Link>{" "}
              page.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {rows.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="grid gap-x-6 gap-y-1 px-5 py-4 transition-colors hover:bg-panel md:grid-cols-[minmax(0,1fr)_auto_7rem]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{p.title}</p>
                    <p className="truncate text-sm font-light text-muted" title={p.stateDetail}>
                      {p.seriesId} · episode {p.episodeNumber}
                      {p.stateDetail ? ` · ${p.stateDetail}` : ""}
                    </p>
                  </div>
                  <div className="self-center">
                    <StateBadge state={p.state} />
                  </div>
                  <span className="self-center text-sm font-light text-muted md:text-right">{ago(p.updatedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DropImport>
    </>
  );
}
