"use client";

import { FileJson, Loader2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { importEpisodeAction, validateDocumentAction, type ImportMode } from "@/app/actions";
import { detectDocType, parseJsonText, type DocType } from "@/lib/episode/validate";

export interface ExistingProject {
  id: string;
  seriesId: string;
  episodeNumber: number;
  title: string;
}

interface DroppedFile {
  fileName: string;
  text: string;
  docType: DocType | null;
  storyId: string | null;
  ok: boolean;
  error: string | null;
  title: string;
  seriesId: string;
  episodeNumber: number;
  segments: number;
  minutes: number | null;
  writtenMode: string;
}

interface Outcome {
  fileName: string;
  id: string | null;
  storyId: string | null;
  error: string | null;
}

const DOC_ORDER: Record<DocType, number> = { story_bible: 0, bundle: 1, episode: 2 };

export const DRAFT_KEY = "slideshow:draft";

const CHOICES: { mode: ImportMode; title: string; detail: string }[] = [
  { mode: "publish", title: "Run to YouTube", detail: "Generate, render and hand to the bot for upload with no stops." },
  { mode: "review", title: "Review before publishing", detail: "Run everything, then wait for your approval before upload." },
  { mode: "import_only", title: "Import only", detail: "Create the project as a draft. Start it yourself later." },
];

function describeWritten(text: string): string {
  try {
    const a = JSON.parse(text)?.automation ?? {};
    if (a.auto_start_on_submit === false) return "import only";
    const gates = a.approval_gates ?? {};
    if (gates.before_render || gates.before_publish) return "with review gates";
    return "run to YouTube";
  } catch {
    return "";
  }
}

/**
 * Validates on the server so episodes see their stored story. Story bibles sort first so an episode dropped
 * together with its story bible validates once the bible is saved (the import revalidates each file).
 */
async function readFiles(files: File[]): Promise<DroppedFile[]> {
  const texts = await Promise.all(files.map(async (file) => ({ fileName: file.name, text: await file.text() })));
  const typed = texts.map((f) => {
    const { raw, errors } = parseJsonText(f.text);
    return { ...f, detected: errors.length ? null : detectDocType(raw) };
  });
  const storiesInDrop = new Set(
    typed.filter((f) => f.detected?.doc_type === "story_bible" || f.detected?.doc_type === "bundle").map((f) => f.detected!.story_id),
  );
  const out = await Promise.all(
    typed.map(async ({ fileName, text, detected }): Promise<DroppedFile> => {
      const result = await validateDocumentAction(text);
      const ep = result.episode;
      const deferred = !!result.needs_story && storiesInDrop.has(result.needs_story);
      const ok = result.ok || deferred;
      const first = result.errors[0];
      return {
        fileName,
        text,
        docType: result.doc_type,
        storyId: detected?.story_id ?? null,
        ok,
        error: ok ? null : `${result.errors.length} error(s), first: ${first?.message ?? "invalid"}${first?.line ? ` (line ${first.line})` : ""}`,
        title: ep?.youtube.title ?? result.story?.story_title ?? fileName,
        seriesId: ep?.series.series_id ?? "",
        episodeNumber: ep?.series.episode_number ?? 0,
        segments: ep?.segments.length ?? 0,
        minutes: result.estimate ? result.estimate.total_seconds / 60 : null,
        writtenMode: result.doc_type === "story_bible" ? "" : describeWritten(text),
      };
    }),
  );
  return out.sort(
    (a, b) => (a.docType ? DOC_ORDER[a.docType] : 3) - (b.docType ? DOC_ORDER[b.docType] : 3) || a.episodeNumber - b.episodeNumber,
  );
}

export function DropImport({ existing, children }: { existing: ExistingProject[]; children: React.ReactNode }) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<DroppedFile[] | null>(null);
  const [replace, setReplace] = useState(true);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const depth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending || busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPending(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, busy]);

  const accept = async (list: File[]) => {
    const json = list.filter((f) => f.name.toLowerCase().endsWith(".json") || f.type.includes("json"));
    setOutcomes(null);
    if (!json.length) {
      setNotice("Drop one or more episode .json files.");
      return;
    }
    setNotice(null);
    const files = await readFiles(json.slice(0, 20));
    setReplace(true);
    setPending(files);
  };

  const run = async (mode: ImportMode) => {
    if (!pending) return;
    const valid = pending.filter((f) => f.ok);
    setBusy({ done: 0, total: valid.length });
    const results: Outcome[] = pending.filter((f) => !f.ok).map((f) => ({ fileName: f.fileName, id: null, storyId: null, error: f.error }));
    for (const [i, f] of valid.entries()) {
      try {
        const res = await importEpisodeAction(f.text, mode, replace);
        results.push({ fileName: f.fileName, id: res.id, storyId: res.storyId, error: res.error });
      } catch (err) {
        results.push({ fileName: f.fileName, id: null, storyId: null, error: err instanceof Error ? err.message : "Import failed." });
      }
      setBusy({ done: i + 1, total: valid.length });
    }
    setBusy(null);
    setPending(null);
    if (results.length === 1 && !results[0].error) {
      router.push(results[0].id ? `/projects/${results[0].id}` : `/stories/${results[0].storyId}`);
      return;
    }
    setOutcomes(results);
    router.refresh();
  };

  const openInEditor = (f: DroppedFile) => {
    sessionStorage.setItem(DRAFT_KEY, f.text);
    router.push("/new?draft=1");
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

  const conflicts = (pending ?? []).filter(
    (f) => f.ok && existing.some((p) => p.seriesId === f.seriesId && p.episodeNumber === f.episodeNumber),
  );
  const validCount = (pending ?? []).filter((f) => f.ok).length;

  return (
    <div className="relative min-h-[60vh]" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
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
          <Upload className="h-4 w-4" />
          Drop episode JSON files anywhere on this page to create projects.
        </span>
        <button type="button" className="btn" onClick={() => picker.current?.click()}>
          Choose files
        </button>
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
          {outcomes.map((o) => (
            <p key={o.fileName} className={o.error ? "text-bad" : ""}>
              <span className="font-mono text-xs text-muted">{o.fileName}</span>{" "}
              {o.id ? (
                <Link href={`/projects/${o.id}`} className="link">
                  created
                </Link>
              ) : o.storyId && !o.error ? (
                <Link href={`/stories/${o.storyId}`} className="link">
                  story saved
                </Link>
              ) : (
                o.error
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
            <p className="text-2xl font-bold tracking-tight">Drop to create projects</p>
            <p className="text-sm font-light text-muted">One project per episode JSON file</p>
          </div>
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !busy && setPending(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="drop-title"
            className="max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="eyebrow">{pending.length === 1 ? "1 file" : `${pending.length} files`}</span>
            <h2 id="drop-title" className="mt-2 text-2xl font-bold tracking-tight">
              How should automation run?
            </h2>

            <ul className="mt-4 flex max-h-48 flex-col gap-2 overflow-auto">
              {pending.map((f) => (
                <li key={f.fileName} className="flex items-start justify-between gap-3 rounded-xl border border-line px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{f.ok ? f.title : f.fileName}</p>
                    {f.ok && f.docType === "story_bible" ? (
                      <p className="text-xs font-light text-muted">story bible · {f.storyId}</p>
                    ) : f.ok ? (
                      <p className="text-xs font-light text-muted">
                        {f.docType === "bundle" ? "story + " : ""}
                        {f.seriesId} · episode {f.episodeNumber} · {f.segments} segments
                        {f.minutes ? ` · ~${f.minutes.toFixed(1)} min` : ""}
                        {f.writtenMode ? ` · file says: ${f.writtenMode}` : ""}
                      </p>
                    ) : (
                      <p className="text-xs text-bad">{f.error}</p>
                    )}
                  </div>
                  {!f.ok && (
                    <button type="button" className="shrink-0 text-xs text-muted underline-offset-4 hover:text-foreground hover:underline" onClick={() => openInEditor(f)}>
                      Fix in editor
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {conflicts.length > 0 && (
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-warn/40 px-3 py-2 text-sm">
                <input type="checkbox" className="mt-1 accent-current" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                <span>
                  <span className="font-medium">Replace existing projects</span>
                  <span className="block text-xs font-light text-muted">
                    {conflicts.map((c) => `${c.seriesId} #${c.episodeNumber}`).join(", ")}{" "}
                    {conflicts.length === 1 ? "already exists" : "already exist"}. Replacing archives the old project and cancels its
                    queued tasks.
                  </span>
                </span>
              </label>
            )}

            {validCount === 0 ? (
              <p className="mt-5 text-sm text-muted">Nothing to import. Fix the errors above first.</p>
            ) : (
              <div className="mt-5 flex flex-col gap-2">
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
            )}

            <div className="mt-5 flex items-center justify-between text-sm">
              {busy ? (
                <span className="flex items-center gap-2 text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" /> Importing {busy.done}/{busy.total}…
                </span>
              ) : validCount > 0 ? (
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
