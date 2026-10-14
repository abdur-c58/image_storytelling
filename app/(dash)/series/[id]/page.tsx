import { connection } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import type { Episode } from "@/lib/episode/schema";
import { CopyButton } from "../../projects/[id]/client";
import { PageHeader, StateBadge } from "../../ui";

export default async function SeriesPage({ params }: PageProps<"/series/[id]">) {
  await connection();
  const { id } = await params;
  const seriesId = decodeURIComponent(id);
  const db = await getDb();
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.seriesId, seriesId), eq(projects.archived, false)))
    .orderBy(asc(projects.episodeNumber), asc(projects.createdAt));
  if (!rows.length) notFound();
  const latest = rows.reduce((a, b) => (b.episodeNumber >= a.episodeNumber ? b : a));
  const ep = latest.episode as Episode;
  const context = {
    series_id: ep.series.series_id,
    series_title: ep.series.series_title,
    next_episode_number: ep.series.episode_number + 1,
    total_episodes_planned: ep.series.total_episodes_planned,
    previous_episode: {
      episode_number: ep.series.episode_number,
      title: ep.youtube.title,
      cliffhanger: ep.series.cliffhanger,
      next_episode_teaser: ep.series.next_episode_teaser,
      youtube_url: latest.youtubeUrl,
    },
    state_carryover: ep.series.state_carryover,
    style_bible: ep.style_bible,
    voice: ep.voice,
    youtube_defaults: {
      channel_name: ep.youtube.channel_name,
      tags: ep.youtube.tags,
      category: ep.youtube.category,
      playlist: ep.youtube.playlist,
      language: ep.youtube.language,
    },
  };
  const contextText = JSON.stringify(context, null, 2);
  return (
    <>
      <PageHeader eyebrow={ep.series.series_id} title={ep.series.series_title} />
      <div className="flex flex-col gap-8">
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
        {rows.map((p) => (
          <li key={p.id} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-panel">
            <span className="w-10 font-mono text-sm text-muted">#{p.episodeNumber}</span>
            <Link href={`/projects/${p.id}`} className="min-w-0 flex-1 truncate font-medium">
              {p.title}
            </Link>
            <StateBadge state={p.state} />
            {p.youtubeUrl && (
              <a href={p.youtubeUrl} target="_blank" rel="noreferrer" className="link text-sm text-ok">
                YouTube
              </a>
            )}
          </li>
        ))}
      </ul>
      <section className="card flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Context for episode {context.next_episode_number}</h2>
          <CopyButton text={contextText} label="Copy for Claude" />
        </div>
        <p className="text-sm font-light text-muted">
          Paste this into Claude with the script contract so the next episode continues the same characters, style and
          state. Copy <code>state_carryover</code> forward and update it at the end of the new episode.
        </p>
        <pre className="max-h-96 overflow-auto rounded-xl border border-line bg-background p-4 text-xs text-muted">{contextText}</pre>
      </section>
      </div>
    </>
  );
}
