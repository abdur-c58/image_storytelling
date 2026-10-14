import { connection } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { episodes, projects } from "@/lib/db/schema";
import { episodeHref, episodeLabel } from "@/lib/episode/naming";
import { projectContext } from "@/lib/pipeline/context";
import type { Revalidation } from "@/lib/pipeline/revalidate";
import { getStory } from "@/lib/pipeline/story";
import { ago, StateBadge } from "../../../../ui";
import { VersionButton } from "../../../../projects/[id]/client";
import { ProjectView } from "../../../../projects/[id]/view";

export default async function EpisodePage({ params, searchParams }: PageProps<"/stories/[id]/episodes/[n]">) {
  await connection();
  const { id, n } = await params;
  const storyId = decodeURIComponent(id);
  const number = Number(n);
  if (!Number.isInteger(number) || number < 1) notFound();
  const db = await getDb();
  const story = await getStory(db, storyId);
  if (!story) notFound();
  const [episode] = await db.select().from(episodes).where(and(eq(episodes.storyId, storyId), eq(episodes.number, number)));
  if (!episode) notFound();
  const versions = await db.select().from(projects).where(eq(projects.episodeId, episode.id)).orderBy(desc(projects.version));
  const wanted = Number((await searchParams).v);
  const current = versions.find((v) => v.version === wanted) ?? versions.find((v) => v.id === episode.activeVersionId) ?? versions[0];
  if (!current) notFound();
  const isActive = current.id === episode.activeVersionId;
  const context = await projectContext(db, current.id);
  const revalidation = current.revalidation as Revalidation | null;

  const breadcrumb = (
    <nav aria-label="Breadcrumb" className="eyebrow flex flex-wrap items-center gap-1">
      <Link href="/stories" className="transition-colors hover:text-foreground">
        Stories
      </Link>
      <span aria-hidden>›</span>
      <Link href={`/stories/${encodeURIComponent(storyId)}`} className="transition-colors hover:text-foreground">
        {story.title}
      </Link>
      <span aria-hidden>›</span>
      <span aria-current="page">{episodeLabel(number, episode.title)}</span>
    </nav>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="card flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Versions">
            <span className="eyebrow mr-1">Versions</span>
            {versions.map((v) => (
              <Link
                key={v.id}
                href={episodeHref(storyId, number, v.version)}
                role="tab"
                aria-selected={v.id === current.id}
                className={`chip gap-2 ${v.id === current.id ? "border-line-hover bg-panel text-foreground" : "hover:text-foreground"}`}
                title={`${v.state} · created ${ago(v.createdAt)}`}
              >
                v{v.version}
                {v.id === episode.activeVersionId && <span className="text-ok">active</span>}
                {v.needsRevalidation && <span className="text-warn">re-check</span>}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {!isActive && <VersionButton projectId={current.id} action={{ kind: "activate" }} label="Set active" confirm={`Make v${current.version} the active version? The current active version stops (it is kept).`} />}
            {isActive && current.archived && story.status !== "deleted" && (
              <VersionButton projectId={current.id} action={{ kind: "activate" }} label="Resume" confirm={`Resume v${current.version}? Its pipeline continues where it stopped.`} />
            )}
            <VersionButton
              projectId={current.id}
              action={{ kind: "duplicate" }}
              label="Duplicate as new version"
              confirm="Store this JSON again as a new version? It becomes the active version, not started."
            />
            <a className="btn" href={`/api/projects/${current.id}/files?kind=json`}>
              Download JSON
            </a>
          </div>
        </div>
        <p className="text-sm font-light text-muted">
          Viewing v{current.version} {isActive ? "(active)" : "(inactive: stopped, kept for reference)"} · <StateBadge state={current.state} />{" "}
          {current.migrated && <span className="chip">migrated</span>} {context.output_basename && <span className="font-mono text-xs">{context.output_basename}</span>}
        </p>
        {revalidation && (
          <div className={`rounded-xl border px-3 py-2 text-sm ${revalidation.ok ? "border-line" : "border-warn/50 text-warn"}`}>
            {revalidation.ok
              ? `Re-checked after Episode ${revalidation.after_episode} changed (${ago(revalidation.checked_at)}): still passes.`
              : `Needs revalidation: after Episode ${revalidation.after_episode} changed, this version fails continuity. Paste a fixed version.`}
            {!revalidation.ok && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {revalidation.errors.slice(0, 6).map((e, i) => (
                  <li key={i}>
                    {e.path_text}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
      <ProjectView id={current.id} breadcrumb={breadcrumb} basename={context.output_basename} onlyVersion={versions.length === 1} />
    </div>
  );
}
