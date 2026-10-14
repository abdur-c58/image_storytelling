import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { presignAssetGet } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { assets, projects, storyMasters, taskEvents, tasks } from "@/lib/db/schema";
import type { StoryState } from "@/lib/episode/continuity";
import type { PromptPart } from "@/lib/episode/prompt";
import type { StoryBible } from "@/lib/episode/schema";
import type { ValidationIssue } from "@/lib/episode/validate";
import { pageBaseUrl } from "@/lib/http";
import { getStory, masterAssetKey } from "@/lib/pipeline/story";
import { CopyButton, AutoRefresh } from "../../projects/[id]/client";
import { ago, StateBadge } from "../../ui";
import { DeleteStoryButton, MasterCard, StoryActionButton, type MasterView } from "./client";

export default async function StoryPage({ params }: PageProps<"/stories/[id]">) {
  const { id } = await params;
  const storyId = decodeURIComponent(id);
  const db = await getDb();
  const story = await getStory(db, storyId);
  if (!story) notFound();
  const bible = story.bible as StoryBible;
  const state = story.storyState as StoryState;
  const base = await pageBaseUrl();

  const [episodes, masterRows, candidateRows, taskRows, events] = await Promise.all([
    db.select().from(projects).where(eq(projects.storyId, storyId)).orderBy(asc(projects.episodeNumber), asc(projects.createdAt)),
    db.select().from(storyMasters).where(eq(storyMasters.storyId, storyId)).orderBy(asc(storyMasters.masterKey)),
    db
      .select()
      .from(assets)
      .where(and(eq(assets.storyId, storyId), eq(assets.status, "ready")))
      .orderBy(desc(assets.createdAt)),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.storyId, storyId), inArray(tasks.status, ["queued", "leased", "dead"])))
      .orderBy(desc(tasks.createdAt)),
    db.select().from(taskEvents).where(eq(taskEvents.storyId, storyId)).orderBy(desc(taskEvents.createdAt)).limit(60),
  ]);

  const masters: MasterView[] = await Promise.all(
    masterRows.map(async (m) => {
      const mine = candidateRows.filter((a) => a.assetKey === masterAssetKey(m.masterKey)).slice(0, 4);
      return {
        key: m.masterKey,
        kind: m.kind,
        label: m.label,
        status: m.status,
        prompt: m.prompt,
        negative: m.negativePrompt,
        parts: m.promptParts as PromptPart[],
        mustMatch: m.mustMatch as string[],
        approvedAssetId: m.approvedAssetId,
        candidates: await Promise.all(
          mine.map(async (a) => ({
            id: a.id,
            url: await presignAssetGet(a, base),
            width: a.width,
            createdAt: a.createdAt.toISOString(),
            lowRes: !!(a.meta as { upscale_needed?: boolean }).upscale_needed,
          })),
        ),
      };
    }),
  );
  const counts = {
    total: masters.length,
    approved: masters.filter((m) => m.status === "approved").length,
    generated: masters.filter((m) => m.status === "generated").length,
  };
  const latestEpisode = episodes.reduce((n, p) => Math.max(n, p.episodeNumber), 0);
  const nextContext = {
    story_id: storyId,
    next_episode_number: Math.max(latestEpisode, state.committed_through_episode) + 1,
    start_state: state.current,
    committed_through_episode: state.committed_through_episode,
    previous_episodes: episodes.map((p) => ({ episode_number: p.episodeNumber, title: p.title, state: p.state })),
  };
  const warnings = story.warnings as ValidationIssue[];
  const gateOn = bible.automation.approval_gates.location_masters;
  const active = taskRows.some((t) => t.status === "queued" || t.status === "leased");

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh enabled={active || story.state === "LOCATION_MASTERS_REQUESTED"} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <span className="eyebrow">
            <Link href="/stories" className="transition-colors hover:text-foreground">
              Stories
            </Link>{" "}
            · <span className="font-mono">{storyId}</span>
          </span>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{story.title}</h1>
            <StateBadge state={story.state} />
          </div>
          <p className="mt-2 font-light text-muted">{story.stateDetail}</p>
          <p className="mt-1 text-sm font-light text-muted">
            {bible.characters.length} characters · {bible.scene_bible.locations.length} locations · updated {ago(story.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {counts.generated > 0 && (
            <StoryActionButton storyId={storyId} action={{ kind: "approve_all" }} label={`Approve all ${counts.generated} new`} primary />
          )}
          <DeleteStoryButton storyId={storyId} episodes={episodes.length} />
        </div>
      </div>

      <section className="card flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="eyebrow">
            Location masters{" "}
            <span className="text-sm font-normal text-muted">
              ({counts.approved}/{counts.total} approved{gateOn ? "" : ", gate off"})
            </span>
          </h2>
        </div>
        <p className="text-sm font-light text-muted">
          Empty plates of every location state and angle, plus character sheets. Approved masters are sent to the bot as
          reference images for every episode picture of that place. Regenerate any that don&apos;t match the fixed landmarks
          or the character description.
        </p>
        {masters.length === 0 ? (
          <p className="text-sm text-muted">{gateOn ? "No masters yet." : "Masters are switched off for this story."}</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {masters.map((m) => (
              <MasterCard key={m.key} storyId={storyId} master={m} />
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card flex flex-col gap-3">
          <h2 className="eyebrow">Episodes</h2>
          {episodes.length === 0 ? (
            <p className="text-sm text-muted">No episodes yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {episodes.map((p) => {
                const out = p.outputs as { story_state_end?: unknown; story_state_committed_at?: string };
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <span className="w-10 font-mono text-muted">#{p.episodeNumber}</span>
                    <Link href={`/projects/${p.id}`} className="min-w-0 flex-1 truncate font-medium">
                      {p.title}
                    </Link>
                    <StateBadge state={p.state} />
                    {!!out.story_state_end && !out.story_state_committed_at && (
                      <StoryActionButton storyId={storyId} action={{ kind: "commit_state", projectId: p.id }} label="Commit state" small />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="card flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="eyebrow">Story state</h2>
            <div className="flex gap-2">
              <CopyButton text={JSON.stringify(state, null, 2)} label="Copy JSON" />
              <a
                className="btn px-3 py-0.5 text-xs"
                download={`${storyId}-story_state.json`}
                href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(state, null, 2))}`}
              >
                Download
              </a>
            </div>
          </div>
          <p className="text-xs font-light text-muted">
            Committed through episode {state.committed_through_episode}. Episodes are validated against the state after the
            previous episode.
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            {Object.entries(state.current.locations).map(([k, v]) => (
              <div key={`l${k}`} className="contents">
                <dt className="font-light text-muted">location {k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
            {Object.entries(state.current.world).map(([k, v]) => (
              <div key={`w${k}`} className="contents">
                <dt className="font-light text-muted">{k}</dt>
                <dd className="font-mono">{String(v)}</dd>
              </div>
            ))}
            {Object.entries(state.current.outfits).map(([k, v]) => (
              <div key={`o${k}`} className="contents">
                <dt className="font-light text-muted">outfit {k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
            <dt className="font-light text-muted">introduced</dt>
            <dd className="font-mono">{state.current.introduced_characters.join(", ") || "–"}</dd>
          </dl>
        </div>
      </section>

      <section className="card flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">Context for episode {nextContext.next_episode_number}</h2>
          <CopyButton text={JSON.stringify(nextContext, null, 2)} label="Copy for Claude" />
        </div>
        <p className="text-sm font-light text-muted">
          Paste this into Claude with the script contract. The next episode only needs <code>story_id</code>, its own
          segments, and <code>bible_additions</code> for anything new.
        </p>
        <pre className="max-h-72 overflow-auto rounded-xl border border-line bg-background p-4 text-xs text-muted">
          {JSON.stringify(nextContext, null, 2)}
        </pre>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <details className="card text-xs">
          <summary className="eyebrow cursor-pointer">Story bible JSON</summary>
          <div className="mt-2 flex justify-end">
            <CopyButton text={JSON.stringify(bible, null, 2)} label="Copy" />
          </div>
          <pre className="mt-2 max-h-[60vh] overflow-auto rounded-xl border border-line bg-background p-4 text-muted">
            {JSON.stringify(bible, null, 2)}
          </pre>
        </details>
        <div className="card flex flex-col gap-1 overflow-auto text-xs" style={{ maxHeight: 480 }}>
          <h2 className="eyebrow mb-2">Log</h2>
          {taskRows
            .filter((t) => t.status === "dead")
            .map((t) => (
              <p key={t.id} className="text-bad">
                {t.type} {t.scope}: {t.error}
              </p>
            ))}
          {warnings.map((w, i) => (
            <p key={`w${i}`} className="text-warn">
              validation: {w.message}
            </p>
          ))}
          {events.map((e) => (
            <p key={e.id} className={e.level === "error" ? "text-bad" : e.level === "warning" ? "text-warn" : "text-muted"}>
              <span className="font-mono">{new Date(e.createdAt).toLocaleTimeString()}</span> {e.message}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}
