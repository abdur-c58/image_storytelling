import { connection } from "next/server";
import Link from "next/link";
import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { agents, projects, stories, tasks } from "@/lib/db/schema";
import { AutoRefresh } from "../projects/[id]/client";
import { ago, PageHeader } from "../ui";

type TaskRow = typeof tasks.$inferSelect;
type Kind = "bot" | "worker";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

const TYPE_LABEL: Record<string, string> = {
  generate_images: "Episode images",
  generate_location_master: "Location masters",
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

function itemCount(t: TaskRow): number | null {
  const items = (t.payload as { items?: unknown[] }).items;
  return Array.isArray(items) ? items.length : null;
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
    const n = itemCount(t);
    return (
      <div className="min-w-0">
        <p className="font-medium">
          {TYPE_LABEL[t.type] ?? t.type}
          {n !== null && <span className="font-normal text-muted"> · {n} item{n === 1 ? "" : "s"}</span>}
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
        {next.length === 0 && <p className="text-sm font-light text-muted">The queue is empty.</p>}
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
