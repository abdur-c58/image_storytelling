import { connection } from "next/server";
import Link from "next/link";
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { agents, episodes, projects, stories, storyMasters, tasks } from "@/lib/db/schema";
import { episodeHref } from "@/lib/episode/naming";
import { ActionButton, AutoRefresh } from "../projects/[id]/client";
import { StoryActionButton } from "../stories/[id]/client";
import { ago, PageHeader } from "../ui";

type TaskRow = typeof tasks.$inferSelect;
type Kind = "bot" | "worker";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const TYPE_LABEL: Record<string, string> = {
  generate_images: "Episode images",
  generate_location_master: "Masters",
  generate_character_group_master: "Group masters",
  upload_youtube: "YouTube upload",
  voice: "Voice",
  voice_sample: "Voice test",
  align: "Align",
  sfx: "Sound effects",
  cards: "Cards",
  thumbnail_compose: "Thumbnail",
  mix: "Mix",
  render: "Render",
};

const FINISHED_TONE: Record<string, string> = { done: "text-ok", failed: "text-warn", dead: "text-bad", cancelled: "text-muted", superseded: "text-muted" };

const KIND_WORD: Record<string, [string, string]> = {
  location: ["location", "locations"],
  character: ["character sheet", "character sheets"],
  group: ["group", "groups"],
};

/** "6 locations, 2 character sheets" for master batches; "3 items" otherwise. */
function itemSummary(t: TaskRow): string | null {
  const items = (t.payload as { items?: { kind?: string }[] }).items;
  if (!Array.isArray(items)) return null;
  const counts = new Map<string, number>();
  for (const i of items) if (i.kind && KIND_WORD[i.kind]) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  if (!counts.size) return `${items.length} item${items.length === 1 ? "" : "s"}`;
  return [...counts].map(([k, n]) => `${n} ${KIND_WORD[k][n === 1 ? 0 : 1]}`).join(", ");
}

function inFuture(date: Date, now: Date): string {
  const sec = Math.max(0, Math.round((date.getTime() - now.getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  await connection();
  const params = await searchParams;
  const kind: Kind = one(params.kind) === "worker" ? "worker" : "bot";
  const db = await getDb();
  const now = new Date();

  // Same order the server leases in: priority first, then oldest.
  const open = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.kind, kind), inArray(tasks.status, ["queued", "leased"])))
    .orderBy(desc(tasks.priority), asc(tasks.createdAt));
  const finished = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.kind, kind), notInArray(tasks.status, ["queued", "leased"])))
    .orderBy(desc(tasks.updatedAt))
    .limit(15);
  const seen = await db.select().from(agents).where(eq(agents.role, kind)).orderBy(desc(agents.lastSeenAt));

  // Work the queue cannot do without you: reviews, failures and approval gates.
  const masterCounts = await db
    .select({
      storyId: storyMasters.storyId,
      title: stories.title,
      toReview: sql<number>`count(*) filter (where ${storyMasters.status} = 'generated')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${storyMasters.status} = 'missing' and ${storyMasters.attempts} >= 3)`.mapWith(Number),
    })
    .from(storyMasters)
    .innerJoin(stories, eq(stories.id, storyMasters.storyId))
    .where(ne(stories.status, "deleted"))
    .groupBy(storyMasters.storyId, stories.title);
  const masterNeeds = masterCounts.filter((m) => m.toReview > 0 || m.failed > 0);
  const stuckEpisodes = await db
    .select({
      id: projects.id,
      storyId: projects.storyId,
      number: projects.episodeNumber,
      title: episodes.title,
      state: projects.state,
      detail: projects.stateDetail,
    })
    .from(episodes)
    .innerJoin(projects, eq(projects.id, episodes.activeVersionId))
    .where(and(eq(projects.archived, false), inArray(projects.state, ["FAILED", "REVIEW"])))
    .orderBy(asc(projects.episodeNumber));
  const needsYou = masterNeeds.length + stuckEpisodes.length;

  const running = open.filter((t) => t.status === "leased");
  const next = open.filter((t) => t.status === "queued" && t.availableAt <= now);
  const waiting = open.filter((t) => t.status === "queued" && t.availableAt > now).sort((a, b) => +a.availableAt - +b.availableAt);

  const all = [...open, ...finished];
  const projectIds = [...new Set(all.map((t) => t.projectId).filter((x): x is string => !!x))];
  const storyIds = [...new Set(all.map((t) => t.storyId).filter((x): x is string => !!x))];
  const projectRows = projectIds.length
    ? await db
        .select({ id: projects.id, title: projects.title, episodeNumber: projects.episodeNumber, storyId: projects.storyId })
        .from(projects)
        .where(inArray(projects.id, projectIds))
    : [];
  const projectsById = new Map(projectRows.map((p) => [p.id, p]));
  const storyRows = storyIds.length ? await db.select({ id: stories.id, title: stories.title }).from(stories).where(inArray(stories.id, storyIds)) : [];
  const storyTitles = new Map(storyRows.map((s) => [s.id, s.title]));

  const owner = (t: TaskRow) => {
    if (t.projectId) {
      const p = projectsById.get(t.projectId);
      return (
        <Link href={`/projects/${encodeURIComponent(t.projectId)}`} className="hover:text-foreground">
          {p ? `Ep. ${p.episodeNumber}: ${p.title}` : t.projectId}
        </Link>
      );
    }
    if (t.storyId) {
      return (
        <Link href={`/stories/${encodeURIComponent(t.storyId)}`} className="hover:text-foreground">
          {storyTitles.get(t.storyId) ?? t.storyId}
        </Link>
      );
    }
    return null;
  };

  const head = (t: TaskRow) => {
    const summary = itemSummary(t);
    return (
      <div className="min-w-0">
        <p className="font-medium">
          {TYPE_LABEL[t.type] ?? t.type}
          {summary && <span className="font-normal text-muted"> · {summary}</span>}
        </p>
        <p className="truncate text-xs text-muted">
          {owner(t)} · <span className="font-mono">{t.scope}</span>
        </p>
      </div>
    );
  };

  const tab = (k: Kind, label: string) => (
    <Link href={k === "bot" ? "/queue" : "/queue?kind=worker"} className={`chip ${kind === k ? "border-line-hover text-foreground" : ""}`}>
      {label}
    </Link>
  );

  return (
    <>
      <AutoRefresh enabled />
      <PageHeader eyebrow="Queue" title={kind === "bot" ? "Bot tasks" : "Worker tasks"}>
        {tab("bot", "Bot")}
        {tab("worker", "Worker")}
      </PageHeader>

      <p className="-mt-4 mb-6 text-sm font-light text-muted">
        {seen.length
          ? `${seen.map((a) => `${a.agentId} last checked in ${ago(a.lastSeenAt)}`).join(" · ")}.`
          : `No ${kind} has checked in yet.`}{" "}
        The {kind} takes one task at a time: highest priority first, then oldest. This page refreshes every 5 seconds.
      </p>

      {needsYou > 0 && (
        <section className="mb-8">
          <h2 className="eyebrow mb-3">Needs you ({needsYou})</h2>
          <div className="flex flex-col gap-2">
            {masterNeeds.map((m) => (
              <div key={m.storyId} className="card flex flex-col gap-2 border-warn/40 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">
                    <Link href={`/stories/${encodeURIComponent(m.storyId)}?tab=bible`} className="hover:underline">
                      {m.title}
                    </Link>
                  </p>
                  <p className="text-xs text-muted">
                    {[
                      m.toReview ? `${m.toReview} master${m.toReview === 1 ? "" : "s"} waiting for your approval; episode images that use them wait too` : "",
                      m.failed ? `${m.failed} master${m.failed === 1 ? "" : "s"} failed 3 times (press Regenerate on them)` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {m.toReview > 0 && (
                  <StoryActionButton storyId={m.storyId} action={{ kind: "approve_all" }} label={`Approve all ${m.toReview}`} primary small />
                )}
              </div>
            ))}
            {stuckEpisodes.map((e) => (
              <div key={e.id} className="card flex flex-col gap-2 border-warn/40 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-medium">
                    <Link href={e.storyId ? episodeHref(e.storyId, e.number) : `/projects/${encodeURIComponent(e.id)}`} className="hover:underline">
                      Ep. {e.number}: {e.title}
                    </Link>{" "}
                    <span className={`text-xs font-normal ${e.state === "FAILED" ? "text-bad" : "text-warn"}`}>
                      {e.state === "FAILED" ? "failed" : "waiting for your approval"}
                    </span>
                  </p>
                  <p className="break-words text-xs text-muted">{e.detail}</p>
                </div>
                {e.state === "FAILED" && <ActionButton projectId={e.id} action={{ kind: "retry" }} label="Retry failed" primary small />}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="eyebrow mb-3">Running now ({running.length})</h2>
        {running.length === 0 && <p className="text-sm font-light text-muted">Nothing is running.</p>}
        <div className="flex flex-col gap-2">
          {running.map((t) => {
            const p = t.progress as { completed_items?: number; total_items?: number; message?: string };
            return (
              <div key={t.id} className="card flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                {head(t)}
                <div className="shrink-0 text-xs text-muted sm:text-right">
                  <p className="text-info">
                    {t.leasedBy} · attempt {t.attempts}/{t.maxAttempts}
                    {p.total_items ? ` · ${p.completed_items ?? 0}/${p.total_items} done` : ""}
                  </p>
                  <p>
                    started {ago(t.firstLeasedAt)} · heartbeat {ago(t.lastHeartbeatAt)}
                    {p.message ? ` · ${p.message}` : ""}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="eyebrow mb-3">Up next ({next.length})</h2>
        {next.length === 0 && (
          <p className="text-sm font-light text-muted">The queue is empty.{needsYou > 0 ? " Everything else is waiting on the items under Needs you." : ""}</p>
        )}
        <div className="flex flex-col gap-2">
          {next.map((t, i) => (
            <div key={t.id} className="card flex items-center gap-3">
              <span className="w-6 shrink-0 text-right font-mono text-sm text-muted">{i + 1}</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                {head(t)}
                <div className="shrink-0 text-xs text-muted sm:text-right">
                  <p>
                    priority {t.priority} · queued {ago(t.createdAt)}
                    {t.attempts ? ` · ${t.attempts} earlier attempt${t.attempts === 1 ? "" : "s"}` : ""}
                  </p>
                  {t.error && <p className="max-w-96 truncate text-warn">last error: {t.error}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {waiting.length > 0 && (
        <section className="mb-8">
          <h2 className="eyebrow mb-3">Waiting to retry ({waiting.length})</h2>
          <div className="flex flex-col gap-2">
            {waiting.map((t) => (
              <div key={t.id} className="card flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                {head(t)}
                <div className="shrink-0 text-xs text-muted sm:text-right">
                  <p>
                    available in {inFuture(t.availableAt, now)} · attempt {t.attempts}/{t.maxAttempts}
                  </p>
                  {t.error && <p className="max-w-96 truncate text-warn">last error: {t.error}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="eyebrow mb-3">Recently finished</h2>
        {finished.length === 0 && <p className="text-sm font-light text-muted">Nothing yet.</p>}
        <div className="flex flex-col gap-2">
          {finished.map((t) => (
            <div key={t.id} className="card flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              {head(t)}
              <div className="shrink-0 text-xs text-muted sm:text-right">
                <p className={FINISHED_TONE[t.status] ?? "text-muted"}>
                  {t.status} {ago(t.completedAt ?? t.updatedAt)}
                </p>
                {t.error && t.status !== "done" && <p className="max-w-96 truncate">{t.error}</p>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
