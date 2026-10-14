import { connection } from "next/server";
import Link from "next/link";
import { BookOpen, Search } from "lucide-react";
import { presignAssetGet } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { BUCKET_DOT, BUCKET_LABEL, STATUS_BUCKETS } from "@/lib/episode/status";
import { pageBaseUrl } from "@/lib/http";
import { daysUntilPurge, storySummaries, TRASH_DAYS } from "@/lib/pipeline/folders";
import { ago, PageHeader } from "../ui";
import { RestoreStoryButton } from "./[id]/client";
import { ImportDrop } from "./import";
import { NewStoryButton } from "./new-story";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function StoriesPage({ searchParams }: PageProps<"/stories">) {
  await connection();
  const params = await searchParams;
  const q = (one(params.q) ?? "").trim().toLowerCase();
  const trash = one(params.trash) === "1";
  const withArchived = one(params.archived) === "1";
  const layout = one(params.view) === "list" ? "list" : "grid";
  const newSlug = one(params.new) ?? null;
  const db = await getDb();
  const base = await pageBaseUrl();
  const all = await storySummaries(db, trash ? "trash" : "active", withArchived);
  const rows = q ? all.filter((r) => r.story.title.toLowerCase().includes(q) || r.story.id.includes(q)) : all;
  const covers = new Map(
    await Promise.all(rows.filter((r) => r.cover).map(async (r) => [r.story.id, await presignAssetGet(r.cover!, base)] as const)),
  );
  const href = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const merged = { q: q || null, archived: withArchived ? "1" : null, trash: trash ? "1" : null, view: layout === "list" ? "list" : null, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return s ? `/stories?${s}` : "/stories";
  };

  return (
    <ImportDrop>
      <PageHeader eyebrow={trash ? "Trash" : "Library"} title={trash ? "Deleted stories" : "Stories"}>
        {!trash && <NewStoryButton key={newSlug ?? ""} initialSlug={newSlug} />}
      </PageHeader>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        <form action="/stories" className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input name="q" defaultValue={q} placeholder="Search stories" className="input w-full pl-9" aria-label="Search stories" />
          {withArchived && <input type="hidden" name="archived" value="1" />}
          {trash && <input type="hidden" name="trash" value="1" />}
          {layout === "list" && <input type="hidden" name="view" value="list" />}
        </form>
        {!trash && (
          <Link href={href({ archived: withArchived ? null : "1" })} className={`chip ${withArchived ? "border-line-hover text-foreground" : ""}`}>
            {withArchived ? "Showing archived" : "Show archived"}
          </Link>
        )}
        <Link href={href({ view: layout === "list" ? null : "list" })} className="chip">
          {layout === "list" ? "Grid" : "List"}
        </Link>
        <Link href={trash ? "/stories" : href({ trash: "1", archived: null })} className="chip">
          {trash ? "Back to stories" : "Trash"}
        </Link>
      </div>

      {trash && (
        <p className="-mt-2 mb-6 text-sm font-light text-muted">
          Deleted stories are kept for {TRASH_DAYS} days, then removed with all their files. Restoring brings back every episode and
          version; stopped pipelines start again.
        </p>
      )}

      {rows.length === 0 && (
        <div className="dot-grid flex flex-col items-center gap-2 rounded-2xl border border-line py-20 text-center font-light text-muted">
          <BookOpen className="h-8 w-8" />
          {trash ? "The trash is empty." : q ? "No stories match." : "No stories yet. Create one, or paste or drop a story bible."}
        </div>
      )}

      <div className={layout === "grid" ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : "flex flex-col gap-2"}>
        {rows.map(({ story: s, episodes, planned, buckets, lastActivity }) => {
          const cover = covers.get(s.id);
          const roll = STATUS_BUCKETS.filter((b) => buckets[b]);
          const purgeIn = daysUntilPurge(s.deletedAt);
          const body = (
            <>
              {layout === "grid" && (
                <div className="aspect-video overflow-hidden rounded-xl border border-line bg-panel">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element -- presigned storage URL
                    <img src={cover} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="dot-grid flex h-full items-center justify-center text-muted">
                      <BookOpen className="h-6 w-6" />
                    </div>
                  )}
                </div>
              )}
              <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold tracking-tight">{s.title}</p>
                  <p className="font-mono text-xs text-muted">{s.id}</p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  {s.status === "archived" && <span className="chip">Archived</span>}
                  {!s.bible && <span className="chip text-warn">No bible</span>}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="chip">
                  {episodes}
                  {planned ? ` / ${planned}` : ""} episode{(planned ?? episodes) === 1 ? "" : "s"}
                </span>
                {roll.map((b) => (
                  <span key={b} className="chip gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${BUCKET_DOT[b]}`} aria-hidden />
                    {buckets[b]} {BUCKET_LABEL[b].toLowerCase()}
                  </span>
                ))}
                <span className="text-muted">
                  {trash && purgeIn !== null ? `removed in ${purgeIn} day${purgeIn === 1 ? "" : "s"}` : `active ${ago(lastActivity)}`}
                </span>
              </div>
            </>
          );
          const cls = `card group flex gap-3 ${layout === "grid" ? "flex-col" : "flex-col sm:flex-row sm:items-center"}`;
          return trash ? (
            <div key={s.id} className={cls}>
              {body}
              <div className="flex gap-2">
                <RestoreStoryButton storyId={s.id} />
                <Link href={`/stories/${encodeURIComponent(s.id)}?tab=settings`} className="btn">
                  Delete forever…
                </Link>
              </div>
            </div>
          ) : (
            <Link key={s.id} href={`/stories/${encodeURIComponent(s.id)}`} className={`${cls} hover:border-line-hover`}>
              {body}
            </Link>
          );
        })}
      </div>
    </ImportDrop>
  );
}
