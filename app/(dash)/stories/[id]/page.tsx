import { connection } from "next/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { presignAssetGet } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { assets, storyMasters, taskEvents, tasks, type StoryRow } from "@/lib/db/schema";
import { NARRATOR } from "@/lib/episode/constants";
import { initialSnapshot, type StoryState, type StoryStateSnapshot } from "@/lib/episode/continuity";
import type { EpisodeEstimate } from "@/lib/episode/estimate";
import { episodeHref } from "@/lib/episode/naming";
import type { PromptPart } from "@/lib/episode/prompt";
import type { StoryBible } from "@/lib/episode/schema";
import { BUCKET_DOT, BUCKET_LABEL } from "@/lib/episode/status";
import type { ValidationIssue } from "@/lib/episode/validate";
import { pageBaseUrl } from "@/lib/http";
import { daysUntilPurge, episodeGaps, listEpisodes, TRASH_DAYS, type EpisodeListItem } from "@/lib/pipeline/folders";
import { activeSnapshots, computeStoryState } from "@/lib/pipeline/snapshots";
import { effectiveBible, getStory, masterAssetKey } from "@/lib/pipeline/story";
import { storyVoices } from "@/lib/pipeline/voices";
import { AutoRefresh, CopyButton } from "../../projects/[id]/client";
import { ago, fmtSec, StateBadge } from "../../ui";
import { ImportDrop } from "../import";
import {
  CastPanel,
  DeleteStoryButton,
  MasterCard,
  RestoreStoryButton,
  StoryActionButton,
  StorySettingsForm,
  type CastView,
  type MasterView,
} from "./client";

const TABS = [
  { id: "episodes", label: "Episodes" },
  { id: "bible", label: "Story bible" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default async function StoryPage({ params, searchParams }: PageProps<"/stories/[id]">) {
  await connection();
  const { id } = await params;
  const tabParam = (await searchParams).tab;
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "episodes";
  const storyId = decodeURIComponent(id);
  const db = await getDb();
  const story = await getStory(db, storyId);
  if (!story) notFound();
  const [list, taskRows] = await Promise.all([
    listEpisodes(db, storyId),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.storyId, storyId), inArray(tasks.status, ["queued", "leased", "dead"])))
      .orderBy(desc(tasks.createdAt)),
  ]);
  const deleted = story.status === "deleted";
  const busy = taskRows.some((t) => t.status === "queued" || t.status === "leased");
  const href = (t: Tab) => `/stories/${encodeURIComponent(storyId)}${t === "episodes" ? "" : `?tab=${t}`}`;
  const purgeIn = daysUntilPurge(story.deletedAt);
  const planned = (story.bible as StoryBible | null)?.total_episodes_planned ?? null;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh enabled={busy || story.state === "LOCATION_MASTERS_REQUESTED" || list.some((e) => e.bucket === "in_progress" || e.bucket === "awaiting_bot")} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="eyebrow flex items-center gap-1">
            <Link href="/stories" className="transition-colors hover:text-foreground">
              Stories
            </Link>
            <span aria-hidden>›</span>
            <span className="font-mono" aria-current="page">
              {storyId}
            </span>
          </nav>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{story.title}</h1>
            <StateBadge state={story.state} />
            {story.status === "archived" && <span className="chip">Archived</span>}
            {deleted && <span className="chip text-bad">In the trash</span>}
          </div>
          {story.description && <p className="mt-2 max-w-2xl font-light text-muted">{story.description}</p>}
          <p className="mt-1 text-sm font-light text-muted">
            {list.length}
            {planned ? ` of ${planned}` : ""} episode{(planned ?? list.length) === 1 ? "" : "s"} · {story.stateDetail} · updated {ago(story.updatedAt)}
          </p>
        </div>
        {deleted && <RestoreStoryButton storyId={storyId} />}
      </div>

      {deleted && (
        <div className="rounded-2xl border border-bad/40 px-4 py-3 text-sm text-bad">
          This story is in the trash. It is deleted with all its files in {purgeIn} day{purgeIn === 1 ? "" : "s"} unless you restore it. Its
          episodes are stopped.
        </div>
      )}

      <div role="tablist" aria-label="Story sections" className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={href(t.id)}
            role="tab"
            aria-selected={tab === t.id}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${tab === t.id ? "border-foreground font-medium" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "episodes" && <EpisodesTab story={story} list={list} deleted={deleted} />}
      {tab === "bible" && <BibleTab story={story} taskRows={taskRows} deleted={deleted} />}
      {tab === "settings" && <SettingsTab story={story} episodes={list.length} />}
    </div>
  );
}

function runtimeOf(e: EpisodeListItem): number | null {
  const p = e.active;
  if (!p) return null;
  const out = p.outputs as { duration_sec?: number };
  return out.duration_sec ?? (p.estimate as EpisodeEstimate | null)?.total_seconds ?? null;
}

async function EpisodesTab({ story, list, deleted }: { story: StoryRow; list: EpisodeListItem[]; deleted: boolean }) {
  const storyId = story.id;
  const gaps = episodeGaps(list.map((e) => e.number));
  const rows: ({ kind: "ep"; e: EpisodeListItem } | { kind: "gap"; n: number })[] = [
    ...list.map((e) => ({ kind: "ep" as const, e })),
    ...gaps.map((n) => ({ kind: "gap" as const, n })),
  ].sort((a, b) => (a.kind === "ep" ? a.e.number : a.n) - (b.kind === "ep" ? b.e.number : b.n));
  const noBible = !story.bible;
  const addHref = `/new?story=${encodeURIComponent(storyId)}`;

  const table = (
    <section className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">Episodes</h2>
        {!deleted &&
          (noBible ? (
            <span className="flex items-center gap-2 text-sm text-muted">
              <button type="button" className="btn" disabled title="Add the story bible first">
                Add episode
              </button>
              Add the story bible first
            </span>
          ) : (
            <Link href={addHref} className="btn-primary">
              Add episode
            </Link>
          ))}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{noBible ? "No episodes yet. Paste the story bible first, then add Episode 1." : "No episodes yet."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) =>
            r.kind === "gap" ? (
              <li key={`gap-${r.n}`} className="flex items-center gap-3 py-2 text-sm text-warn">
                <span className="w-12 font-mono">#{r.n}</span>
                <span className="font-light">Missing: later episodes are checked against the story state before this gap.</span>
              </li>
            ) : (
              <EpisodeRow key={r.e.episodeId} storyId={storyId} e={r.e} runtime={runtimeOf(r.e)} />
            ),
          )}
        </ul>
      )}
    </section>
  );

  if (deleted) return table;
  const state = story.bible ? await computeStoryState(await getDb(), storyId, effectiveBible(story)) : null;
  const latest = list.reduce((n, e) => Math.max(n, e.number), 0);
  const nextContext = state && {
    story_id: storyId,
    story_title: story.title,
    next_episode_number: latest + 1,
    start_state: state.current,
    committed_through_episode: state.committed_through_episode,
    previous_episodes: list.map((e) => ({ episode_number: e.number, episode_title: e.title, state: e.active?.state ?? null })),
  };

  return (
    <ImportDrop scope={storyId} episodesBlocked={noBible ? "Add the story bible first" : null}>
      <div className="flex flex-col gap-6">
        {table}
        {nextContext && (
          <section className="card flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="eyebrow">Context for episode {nextContext.next_episode_number}</h2>
              <CopyButton text={JSON.stringify(nextContext, null, 2)} label="Copy for Claude" />
            </div>
            <p className="text-sm font-light text-muted">
              Paste this into Claude with the script contract. The next episode needs <code>story_id</code>,{" "}
              <code>episode_number</code>, <code>episode_title</code>, its own segments, and <code>bible_additions</code> for anything
              new.
            </p>
            <pre className="max-h-72 overflow-auto rounded-xl border border-line bg-background p-4 text-xs text-muted">
              {JSON.stringify(nextContext, null, 2)}
            </pre>
          </section>
        )}
      </div>
    </ImportDrop>
  );
}

function EpisodeRow({ storyId, e, runtime }: { storyId: string; e: EpisodeListItem; runtime: number | null }) {
  const p = e.active;
  const out = (p?.outputs ?? {}) as { story_state_end?: unknown; story_state_committed_at?: string };
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
      <span className="w-12 font-mono text-muted">#{e.number}</span>
      <Link href={episodeHref(storyId, e.number)} className="min-w-0 flex-1 truncate font-medium hover:underline">
        {e.title}
      </Link>
      {e.bucket && (
        <span className="chip gap-1.5" title={p?.state}>
          <span className={`h-2 w-2 rounded-full ${BUCKET_DOT[e.bucket]}`} aria-hidden />
          {BUCKET_LABEL[e.bucket]}
        </span>
      )}
      {p?.needsRevalidation && (
        <Link href={episodeHref(storyId, e.number)} className="chip text-warn" title="An earlier episode changed and this version now fails continuity">
          needs revalidation
        </Link>
      )}
      {e.migrated && <span className="chip text-muted">migrated</span>}
      <span className="w-16 text-right font-mono text-xs text-muted">{runtime ? fmtSec(runtime) : "–"}</span>
      <span className="w-20 text-right text-xs text-muted" title={`${e.versions} version${e.versions === 1 ? "" : "s"}`}>
        {p ? `v${p.version}` : "–"}
        {e.versions > 1 ? ` of ${e.versions}` : ""}
      </span>
      {p?.youtubeUrl ? (
        <a href={p.youtubeUrl} target="_blank" rel="noreferrer" className="link w-16 text-xs">
          YouTube
        </a>
      ) : (
        <span className="w-16" />
      )}
      {p && !!out.story_state_end && !out.story_state_committed_at && (
        <StoryActionButton storyId={storyId} action={{ kind: "commit_state", projectId: p.id }} label="Commit state" small />
      )}
    </li>
  );
}

type TaskRow = typeof tasks.$inferSelect;

/** What the cast table says under "Test voice" while a test is pending or after it failed. */
function voiceTestStatus(task: TaskRow | undefined, lastSample: Date | null, now = new Date()): CastView["sampleStatus"] {
  if (!task) return null;
  if (task.status === "leased") return { tone: "info", text: "Recording the test line…" };
  if (task.status === "queued") {
    if (task.error) return { tone: "bad", text: `Retrying after an error: ${task.error}` };
    const waitedMin = (now.getTime() - task.createdAt.getTime()) / 60_000;
    return waitedMin > 1
      ? { tone: "muted", text: "Still queued after a minute. Is the worker running on your PC?" }
      : { tone: "muted", text: "Queued: waiting for the worker to pick it up…" };
  }
  if (task.status === "dead" && (!lastSample || lastSample < task.updatedAt)) {
    return { tone: "bad", text: `Voice test failed: ${task.error ?? "no error message"}` };
  }
  return null;
}

async function BibleTab({ story, taskRows, deleted }: { story: StoryRow; taskRows: (typeof tasks.$inferSelect)[]; deleted: boolean }) {
  const storyId = story.id;
  if (!story.bible) {
    return deleted ? (
      <p className="text-sm text-muted">This story has no bible.</p>
    ) : (
      <ImportDrop scope={storyId}>
        <section className="card flex flex-col gap-3">
          <h2 className="eyebrow">No story bible yet</h2>
          <p className="text-sm font-light text-muted">
            Paste or drop the story bible for this folder. Its <code className="font-mono">story_id</code> must be{" "}
            <code className="font-mono">&quot;{storyId}&quot;</code>. Episodes can be added once it is saved.
          </p>
          <div>
            <Link href={`/new?story=${encodeURIComponent(storyId)}`} className="btn-primary">
              Open the editor
            </Link>
          </div>
        </section>
      </ImportDrop>
    );
  }
  const db = await getDb();
  const bible = effectiveBible(story);
  const base = await pageBaseUrl();
  const [masterRows, candidateRows, events, snapshots] = await Promise.all([
    db.select().from(storyMasters).where(eq(storyMasters.storyId, storyId)).orderBy(asc(storyMasters.masterKey)),
    db
      .select()
      .from(assets)
      .where(and(eq(assets.storyId, storyId), eq(assets.status, "ready")))
      .orderBy(desc(assets.createdAt)),
    db.select().from(taskEvents).where(eq(taskEvents.storyId, storyId)).orderBy(desc(taskEvents.createdAt)).limit(60),
    activeSnapshots(db, storyId),
  ]);
  const state: StoryState = await computeStoryState(db, storyId, bible);

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
  const sampleUrls = new Map<string, string>();
  const sampleAt = new Map<string, Date>();
  for (const a of candidateRows) {
    if (!a.assetKey.startsWith("voice_sample/")) continue;
    const speaker = a.assetKey.slice("voice_sample/".length);
    if (!sampleUrls.has(speaker)) {
      sampleUrls.set(speaker, await presignAssetGet(a, base));
      sampleAt.set(speaker, a.createdAt);
    }
  }
  const sampleTasks = new Map<string, TaskRow>();
  for (const t of taskRows) {
    const speaker = (t.payload as { speaker?: unknown }).speaker;
    if (t.type === "voice_sample" && typeof speaker === "string" && !sampleTasks.has(speaker)) sampleTasks.set(speaker, t);
  }
  const sampleStatus = (speaker: string) => voiceTestStatus(sampleTasks.get(speaker), sampleAt.get(speaker) ?? null);
  const thumbOf = (key: string) => {
    const m = masters.find((x) => x.key === key);
    const c = m?.candidates.find((x) => x.id === m.approvedAssetId) ?? m?.candidates[0];
    return c ? { key, url: c.url, approved: m?.status === "approved" } : null;
  };
  const status = state.current.character_status ?? {};
  const effective = await storyVoices(db, storyId);
  const overrides = story.voiceOverrides as Record<string, string>;
  const voiceOf = (speaker: string) => ({
    voiceId: effective.voices[speaker]?.voice_id ?? "",
    voiceSource: effective.sources[speaker] ?? null,
    voiceOverride: overrides[speaker] ?? "",
  });
  const cast: CastView[] = [
    {
      id: NARRATOR,
      name: "Narrator",
      role: bible.narrator.pov.replace("_", " "),
      scope: null,
      status: null,
      lastSeen: null,
      ...voiceOf(NARRATOR),
      voiceGroup: null,
      canSpeak: true,
      sampleUrl: sampleUrls.get(NARRATOR) ?? null,
      sampleStatus: sampleStatus(NARRATOR),
      sheets: [],
    },
    ...bible.characters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      scope: c.scope,
      status: status[c.id]?.status ?? c.initial_status,
      lastSeen: status[c.id]?.last_seen_episode ?? null,
      ...voiceOf(c.id),
      voiceGroup: c.voice_group,
      canSpeak: !!c.voice,
      sampleUrl: sampleUrls.get(c.id) ?? null,
      sampleStatus: sampleStatus(c.id),
      sheets: [
        ...c.outfit_states.map((o) => thumbOf(`char/${c.id}/${o.id}`)),
        ...(bible.character_groups ?? []).filter((g) => g.character_ids.includes(c.id)).map((g) => thumbOf(`group/${g.id}`)),
      ].filter((x): x is NonNullable<typeof x> => !!x),
    })),
  ];
  const characterMasters = masters.filter((m) => m.kind !== "location");
  const locationMasters = masters.filter((m) => m.kind === "location");
  const counts = {
    total: masters.length,
    approved: masters.filter((m) => m.status === "approved").length,
    generated: masters.filter((m) => m.status === "generated").length,
  };
  const warnings = story.warnings as ValidationIssue[];
  const gateOn = bible.automation.approval_gates.location_masters;
  const history = locationHistory(bible, snapshots);
  const stateJson = JSON.stringify(state, null, 2);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm font-light text-muted">
        {bible.characters.length} characters · {bible.scene_bible.locations.length} locations · bible version {story.bibleVersion}
      </p>
      {counts.generated > 0 && !deleted && (
        <div>
          <StoryActionButton storyId={storyId} action={{ kind: "approve_all" }} label={`Approve all ${counts.generated} new masters`} primary />
        </div>
      )}

      <section className="card flex flex-col gap-3">
        <h2 className="eyebrow">
          Cast <span className="text-sm font-normal text-muted">(status after episode {state.committed_through_episode})</span>
        </h2>
        <CastPanel storyId={storyId} cast={cast} />
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="eyebrow">Locations</h2>
        <p className="text-sm font-light text-muted">State of each location after every episode (active versions). Highlighted cells changed in that episode.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 pr-3">Location</th>
                <th className="pr-3">Start</th>
                {history.episodes.map((n) => (
                  <th key={n} className="pr-3">
                    after ep {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 pr-3">
                    <p className="font-medium">{r.name}</p>
                    <p className="font-mono text-muted">{r.id}</p>
                  </td>
                  <td className="pr-3 font-mono">{r.initial}</td>
                  {r.after.map((v, i) => (
                    <td key={i} className={`pr-3 font-mono ${v.changed ? "text-info" : "text-muted"}`}>
                      {v.state ?? "–"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card flex flex-col gap-3">
        <h2 className="eyebrow">
          Masters{" "}
          <span className="text-sm font-normal text-muted">
            ({counts.approved}/{counts.total} approved{gateOn ? "" : ", gate off"})
          </span>
        </h2>
        <p className="text-sm font-light text-muted">
          Character sheets, group sheets and empty plates of every location state and angle. Approved masters are sent to the bot as
          reference images for every episode picture they appear in.
        </p>
        {masters.length === 0 ? (
          <p className="text-sm text-muted">{gateOn ? "No masters yet." : "Masters are switched off for this story."}</p>
        ) : (
          <>
            {characterMasters.length > 0 && (
              <>
                <h3 className="text-sm font-medium">Characters and groups</h3>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {characterMasters.map((m) => (
                    <MasterCard key={m.key} storyId={storyId} master={m} />
                  ))}
                </div>
              </>
            )}
            {locationMasters.length > 0 && (
              <>
                <h3 className="text-sm font-medium">Locations</h3>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {locationMasters.map((m) => (
                    <MasterCard key={m.key} storyId={storyId} master={m} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="eyebrow">Story state</h2>
            <div className="flex gap-2">
              <CopyButton text={stateJson} label="Copy JSON" />
              <a
                className="btn px-3 py-0.5 text-xs"
                download={`${storyId}-story_state.json`}
                href={`data:application/json;charset=utf-8,${encodeURIComponent(stateJson)}`}
              >
                Download
              </a>
            </div>
          </div>
          <p className="text-xs font-light text-muted">
            After episode {state.committed_through_episode}. Each episode is validated against the state after the episode before it.
          </p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
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

      <details className="card text-xs">
        <summary className="eyebrow cursor-pointer">Story bible JSON</summary>
        <div className="mt-2 flex justify-end">
          <CopyButton text={JSON.stringify(story.bible, null, 2)} label="Copy" />
        </div>
        <pre className="mt-2 max-h-[60vh] overflow-auto rounded-xl border border-line bg-background p-4 text-muted">
          {JSON.stringify(story.bible, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function locationHistory(bible: StoryBible, snapshots: { episodeNumber: number; state: StoryStateSnapshot }[]) {
  const episodes = snapshots.map((s) => s.episodeNumber);
  const start = initialSnapshot(bible).locations;
  const rows = bible.scene_bible.locations.map((loc) => {
    let prev: string | null = start[loc.id] ?? null;
    return {
      id: loc.id,
      name: loc.name,
      initial: prev ?? "–",
      after: snapshots.map((s) => {
        const state = s.state.locations[loc.id] ?? null;
        const changed = state !== null && state !== prev;
        if (state !== null) prev = state;
        return { state, changed };
      }),
    };
  });
  return { episodes, rows };
}

function SettingsTab({ story, episodes }: { story: StoryRow; episodes: number }) {
  const deleted = story.status === "deleted";
  return (
    <div className="flex flex-col gap-6">
      {!deleted && (
        <section className="card">
          <StorySettingsForm
            storyId={story.id}
            title={story.title}
            description={story.description ?? ""}
            defaultsOverride={Object.keys((story.defaultsOverride as object) ?? {}).length ? JSON.stringify(story.defaultsOverride, null, 2) : ""}
          />
        </section>
      )}
      {!deleted && (
        <section className="card flex flex-col gap-3">
          <h2 className="eyebrow">Archive</h2>
          <p className="text-sm font-light text-muted">
            {story.status === "archived"
              ? "This story is archived: hidden from the story list by default. Its episodes are untouched."
              : "Hide this story from the story list. Nothing stops or is deleted."}
          </p>
          <div>
            <StoryActionButton
              storyId={story.id}
              action={{ kind: "archive", archived: story.status !== "archived" }}
              label={story.status === "archived" ? "Unarchive" : "Archive"}
            />
          </div>
        </section>
      )}
      <section className="card flex flex-col gap-3 border-bad/30">
        <h2 className="eyebrow text-bad">{deleted ? "Delete forever" : "Delete"}</h2>
        <p className="text-sm font-light text-muted">
          {deleted
            ? "Remove this story, every episode version and all files now instead of waiting for the trash to empty."
            : `Move to the trash. Episodes stop and queued bot tasks are cancelled; restore within ${TRASH_DAYS} days.`}
        </p>
        <div className="flex gap-2">
          {deleted && <RestoreStoryButton storyId={story.id} />}
          <DeleteStoryButton storyId={story.id} title={story.title} episodes={episodes} forever={deleted} />
        </div>
      </section>
    </div>
  );
}
