"use client";

import { ClipboardPaste, FileJson, Loader2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { importEpisodeAction, planIngestAction, type ImportMode } from "@/app/actions";
import { detectDocType, parseJsonText } from "@/lib/episode/validate";
import type { IngestPlan } from "@/lib/pipeline/folders";

interface Pending {
  name: string;
  text: string;
  plan: IngestPlan;
  /** Valid once a story bible in the same drop has been saved. */
  deferred: boolean;
}

interface Outcome {
  name: string;
  href: string | null;
  label: string;
  error: string | null;
}

export const DRAFT_KEY = "slideshow:draft";

const CHOICES: { mode: ImportMode; title: string; detail: string }[] = [
  { mode: "publish", title: "Run to YouTube", detail: "Generate, render and hand to the bot for upload with no stops." },
  { mode: "review", title: "Review before publishing", detail: "Run everything, then wait for your approval before upload." },
  { mode: "import_only", title: "Import only", detail: "Store the episode as a draft. Start it yourself later." },
];

const EPISODE_ACTIONS = new Set(["add_episode", "new_version", "create_story_with_episode"]);
const ORDER: Record<string, number> = { story_bible: 0, bundle: 1, episode: 2 };

/** Plans every file (what it would do) without storing anything. Story bibles sort first. */
async function planFiles(files: { name: string; text: string }[], scope: string | null): Promise<Pending[]> {
  const typed = files.map((f) => {
    const { raw, errors } = parseJsonText(f.text);
    const d = errors.length ? null : detectDocType(raw);
    return { ...f, docType: d?.doc_type ?? null, storyId: d?.story_id ?? null };
  });
  const storiesInDrop = new Set(typed.filter((f) => f.docType === "story_bible" || f.docType === "bundle").map((f) => f.storyId));
  const out: Pending[] = [];
  for (const f of typed) {
    const plan = await planIngestAction(f.text, scope);
    const deferred = !plan.ok && f.docType === "episode" && !!f.storyId && storiesInDrop.has(f.storyId);
    out.push({ name: f.name, text: f.text, plan, deferred });
  }
  return out.sort(
    (a, b) => (ORDER[a.plan.docType ?? ""] ?? 3) - (ORDER[b.plan.docType ?? ""] ?? 3) || (a.plan.episodeNumber ?? 0) - (b.plan.episodeNumber ?? 0),
  );
}

/**
 * Drop or paste story bibles, episodes and bundles. Each file is planned first ("This will add Episode 3 …",
 * a diff for a new version), then stored after confirmation. Inside a story folder (`scope`) files for other
 * stories are refused.
 */
export function ImportDrop({
  scope = null,
  episodesBlocked = null,
  children,
}: {
  scope?: string | null;
  /** Shown instead of the episode actions, e.g. "Add the story bible first". */
  episodesBlocked?: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const depth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if ((!pending && !pasting) || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPending(null);
      setPasting(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, pasting, busy]);

  const check = async (files: { name: string; text: string }[]) => {
    setOutcomes(null);
    setNotice(null);
    setChecking(true);
    try {
      setPending(await planFiles(files.slice(0, 20), scope));
    } finally {
      setChecking(false);
    }
  };

  const accept = async (list: File[]) => {
    const json = list.filter((f) => f.name.toLowerCase().endsWith(".json") || f.type.includes("json"));
    if (!json.length) {
      setNotice("Drop one or more .json files (story bible, episode or bundle).");
      return;
    }
    await check(await Promise.all(json.map(async (f) => ({ name: f.name, text: await f.text() }))));
  };

  const usable = (pending ?? []).filter((p) => p.plan.ok || p.deferred);
  const actionable = usable.filter((p) => p.plan.action !== "bible_unchanged");
  const hasEpisodes = actionable.some((p) => p.deferred || EPISODE_ACTIONS.has(p.plan.action ?? ""));

  const run = async (mode: ImportMode) => {
    if (!pending) return;
    setBusy({ done: 0, total: actionable.length });
    const results: Outcome[] = pending
      .filter((p) => !p.plan.ok && !p.deferred)
      .map((p) => ({ name: p.name, href: null, label: "", error: p.plan.errors[0]?.message ?? "Invalid." }));
    for (const [i, p] of actionable.entries()) {
      try {
        const res = await importEpisodeAction(p.text, mode, scope);
        const label = res.episodeNumber ? `Episode ${res.episodeNumber} v${res.version}` : "story saved";
        results.push({ name: p.name, href: res.href, label, error: res.error });
      } catch (err) {
        results.push({ name: p.name, href: null, label: "", error: err instanceof Error ? err.message : "Import failed." });
      }
      setBusy({ done: i + 1, total: actionable.length });
    }
    setBusy(null);
    setPending(null);
    const ok = results.filter((r) => !r.error && r.href);
    if (results.length === 1 && ok.length === 1) {
      router.push(ok[0].href!);
      return;
    }
    setOutcomes(results);
    router.refresh();
  };

  const openInEditor = (p: Pending) => {
    sessionStorage.setItem(DRAFT_KEY, p.text);
    router.push(scope ? `/new?draft=1&story=${encodeURIComponent(scope)}` : "/new?draft=1");
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    depth.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    void accept(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <div className="relative" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(e) => {
          void accept(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line px-5 py-4 text-sm text-muted">
        <span className="flex items-center gap-2">
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {checking
            ? "Checking…"
            : scope
              ? episodesBlocked
                ? `${episodesBlocked}: drop or paste the story bible here.`
                : "Add episode: drop episode JSON files anywhere on this page, or paste one."
              : "Drop story bibles, episodes or bundles anywhere on this page. Each file files itself into its story."}
        </span>
        <span className="flex gap-2">
          <button type="button" className="btn" onClick={() => setPasting(true)}>
            <ClipboardPaste className="h-4 w-4" /> Paste JSON
          </button>
          <button type="button" className="btn" onClick={() => picker.current?.click()}>
            Choose files
          </button>
        </span>
      </div>

      {notice && <p className="mb-6 text-sm text-warn">{notice}</p>}

      {outcomes && (
        <div className="card mb-6 flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Import</span>
            <button type="button" aria-label="Dismiss" className="text-muted hover:text-foreground" onClick={() => setOutcomes(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
          {outcomes.map((o, i) => (
            <p key={`${o.name}-${i}`} className={o.error ? "text-bad" : ""}>
              <span className="font-mono text-xs text-muted">{o.name}</span>{" "}
              {o.error ? (
                o.error
              ) : o.href ? (
                <Link href={o.href} className="link">
                  {o.label}
                </Link>
              ) : (
                o.label
              )}
            </p>
          ))}
        </div>
      )}

      {children}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
          <div className="dot-grid flex h-full w-full max-w-5xl flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-line-hover">
            <FileJson className="h-10 w-10 text-muted" />
            <p className="text-2xl font-bold tracking-tight">Drop to import</p>
            <p className="text-sm font-light text-muted">You confirm what each file does before anything is stored</p>
          </div>
        </div>
      )}

      {pasting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => setPasting(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="paste-title"
            className="flex max-h-full w-full max-w-2xl flex-col gap-3 rounded-2xl border border-line bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="paste-title" className="text-2xl font-bold tracking-tight">
              Paste JSON
            </h2>
            <textarea
              autoFocus
              className="input h-72 w-full font-mono text-xs"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder='{ "schema_version": "2.3", "doc_type": "episode", "story_id": "…", "episode_number": 1, … }'
              aria-label="Document JSON"
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setPasting(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!pasteText.trim() || checking}
                onClick={() => {
                  setPasting(false);
                  void check([{ name: "pasted.json", text: pasteText }]);
                  setPasteText("");
                }}
              >
                Check
              </button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !busy && setPending(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-title"
            className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="eyebrow">{pending.length === 1 ? "1 file" : `${pending.length} files`}</span>
            <h2 id="import-title" className="mt-2 text-2xl font-bold tracking-tight">
              Confirm import
            </h2>

            <ul className="mt-4 flex max-h-[45vh] flex-col gap-2 overflow-auto">
              {pending.map((p, i) => (
                <li key={`${p.name}-${i}`} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-mono text-xs text-muted">{p.name}</span>
                    {!p.plan.ok && !p.deferred && (
                      <button type="button" className="shrink-0 text-xs text-muted underline-offset-4 hover:text-foreground hover:underline" onClick={() => openInEditor(p)}>
                        Fix in editor
                      </button>
                    )}
                  </div>
                  {p.plan.ok ? (
                    <p className="font-medium">{p.plan.summary}</p>
                  ) : p.deferred ? (
                    <p className="font-medium">
                      Episode {p.plan.episodeNumber} for {p.plan.storyId}: checked again once the story bible above is saved.
                    </p>
                  ) : (
                    p.plan.errors.map((e, ei) => (
                      <p key={ei} className="text-xs text-bad">
                        {e.message}{" "}
                        {e.href && (
                          <Link href={e.href} className="link">
                            {e.linkLabel}
                          </Link>
                        )}
                      </p>
                    ))
                  )}
                  {p.plan.ok && p.plan.diff.length > 0 && (
                    <ul className="list-disc pl-5 text-xs font-light text-muted">
                      {p.plan.diff.map((d, di) => (
                        <li key={di}>{d}</li>
                      ))}
                    </ul>
                  )}
                  {p.plan.ok &&
                    p.plan.warnings.slice(0, 4).map((w, wi) => (
                      <p key={wi} className="text-xs text-warn">
                        {w}
                      </p>
                    ))}
                  {p.plan.ok && p.plan.warnings.length > 4 && <p className="text-xs text-muted">… and {p.plan.warnings.length - 4} more warning(s).</p>}
                </li>
              ))}
            </ul>

            {actionable.length === 0 ? (
              <p className="mt-5 text-sm text-muted">{usable.length ? "Nothing to change." : "Nothing to import. Fix the errors above first."}</p>
            ) : hasEpisodes ? (
              <div className="mt-5 flex flex-col gap-2">
                <p className="text-sm font-light text-muted">How should automation run for the episodes?</p>
                {CHOICES.map((c) => (
                  <button
                    key={c.mode}
                    type="button"
                    disabled={!!busy}
                    onClick={() => void run(c.mode)}
                    className="group flex items-center justify-between gap-4 rounded-xl border border-line bg-panel px-4 py-3 text-left transition-colors hover:border-line-hover hover:bg-panel-hover disabled:opacity-50"
                  >
                    <span>
                      <span className="block font-semibold">{c.title}</span>
                      <span className="block text-xs font-light text-muted">{c.detail}</span>
                    </span>
                    <span className="text-muted transition-transform group-hover:translate-x-0.5">→</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-5 flex justify-end">
                <button type="button" className="btn-primary" disabled={!!busy} onClick={() => void run("as_written")}>
                  Confirm
                </button>
              </div>
            )}

            <div className="mt-5 flex items-center justify-between text-sm">
              {busy ? (
                <span className="flex items-center gap-2 text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Importing {busy.done}/{busy.total}…
                </span>
              ) : hasEpisodes ? (
                <button type="button" className="text-muted transition-colors hover:text-foreground" onClick={() => void run("as_written")}>
                  Use each file&apos;s own settings
                </button>
              ) : (
                <span />
              )}
              <button type="button" disabled={!!busy} className="text-muted transition-colors hover:text-foreground disabled:opacity-50" onClick={() => setPending(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
