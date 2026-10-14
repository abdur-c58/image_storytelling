"use client";

import { useActionState, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createProjectAction, planIngestAction, validateDocumentAction, type CreateState } from "@/app/actions";
import type { IngestPlan } from "@/lib/pipeline/folders";
import { convertV1ToV2 } from "@/lib/episode/migrate";
import { detectDocType, parseJsonText, validateText, type ValidationIssue, type ValidationResult } from "@/lib/episode/validate";
import type { SegmentRole } from "@/lib/episode/schema";
import type { IdentificationReport, PovSegment, StructureReport } from "@/lib/episode/structure";
import { DRAFT_KEY } from "../stories/import";

function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

const DOC_LABEL = { story_bible: "Story bible", episode: "Episode", bundle: "Bundle (story + episode)" } as const;

export function EpisodeEditor({
  examples,
  loadDraft,
  scope = null,
}: {
  examples: { story: string; minimal: string; full: string };
  loadDraft: boolean;
  /** Pasting inside a story folder: documents for other stories are refused. */
  scope?: { id: string; title: string } | null;
}) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const local = useMemo(() => (deferred.trim() ? validateText(deferred) : null), [deferred]);
  const legacy = useMemo(() => {
    if (!deferred.trim()) return false;
    const { raw, errors } = parseJsonText(deferred);
    return !errors.length && detectDocType(raw).legacy;
  }, [deferred]);
  const [server, setServer] = useState<{ text: string; result: ValidationResult } | null>(null);
  const [checking, setChecking] = useState(false);
  const [state, action, pending] = useActionState<CreateState, FormData>(createProjectAction, { error: null });
  const [notes, setNotes] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const [plan, setPlan] = useState<IngestPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const review = async () => {
    setPlanning(true);
    try {
      setPlan(await planIngestAction(text, scope?.id ?? null));
    } finally {
      setPlanning(false);
    }
  };

  // Episodes need the stored story for continuity; ask the server once typing settles.
  const needsServer = !!local && (local.doc_type === "episode" || local.doc_type === "bundle") && !legacy;
  useEffect(() => {
    if (!needsServer) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await validateDocumentAction(deferred, scope?.id ?? null);
        if (!cancelled) setServer({ text: deferred, result });
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deferred, needsServer, scope?.id]);

  const result = needsServer ? (server?.text === deferred ? server.result : null) : local;

  useEffect(() => {
    if (!loadDraft) return;
    const draft = sessionStorage.getItem(DRAFT_KEY);
    if (draft === null) return;
    sessionStorage.removeItem(DRAFT_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hand-off from the projects drop zone
    setText(draft);
  }, [loadDraft]);

  const jump = (issue: ValidationIssue) => {
    if (!issue.line || !area.current) return;
    const lines = text.split("\n");
    let offset = 0;
    for (let i = 0; i < issue.line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += Math.max(0, (issue.column ?? 1) - 1);
    area.current.focus();
    area.current.setSelectionRange(offset, offset);
    const lineHeight = 18;
    area.current.scrollTop = Math.max(0, (issue.line - 5) * lineHeight);
  };

  const onDrop = async (e: DragEvent<HTMLTextAreaElement>) => {
    const file = e.dataTransfer.files?.[0];
    setDragging(false);
    if (!file) return;
    e.preventDefault();
    setNotes([]);
    setText(await file.text());
  };

  const convert = () => {
    const { bundle, notes } = convertV1ToV2(JSON.parse(text));
    setNotes(notes);
    setText(JSON.stringify(bundle, null, 2));
  };

  const load = (value: string) => {
    setNotes([]);
    setText(value);
  };

  const est = result?.estimate;
  const docType = local?.doc_type ?? null;
  const submitLabel = docType === "story_bible" ? "Review and save story" : docType === "bundle" ? "Review and save story + episode" : "Review and add episode";
  const status = !local
    ? "Waiting for JSON"
    : !result
      ? "Checking continuity…"
      : result.ok
        ? "Valid"
        : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`;
  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[1fr_360px]">
      {scope && <input type="hidden" name="scope" value={scope.id} />}
      {plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !pending && setPlan(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-title"
            className="max-h-full w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="eyebrow">{plan.ok ? "Confirm" : "Can't save"}</span>
            <h2 id="plan-title" className="mt-2 text-xl font-bold tracking-tight">
              {plan.ok ? plan.summary : "This document can't be stored here"}
            </h2>
            {plan.diff.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-sm font-light text-muted">
                {plan.diff.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {plan.errors.map((e, i) => (
              <p key={i} className="mt-2 text-sm text-bad">
                {e.message}{" "}
                {e.href && (
                  <a href={e.href} className="link">
                    {e.linkLabel}
                  </a>
                )}
              </p>
            ))}
            {plan.warnings.slice(0, 5).map((w, i) => (
              <p key={i} className="mt-2 text-xs text-warn">
                {w}
              </p>
            ))}
            {state.error && !pending && <p className="mt-3 text-sm text-bad">{state.error}</p>}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setPlan(null)} disabled={pending}>
                Cancel
              </button>
              {plan.ok && plan.action !== "bible_unchanged" && (
                <button type="submit" className="btn-primary" disabled={pending}>
                  {pending ? "Saving…" : "Confirm"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => load(examples.story)}>
            Story bible example
          </button>
          <button type="button" className="btn" onClick={() => load(examples.minimal)}>
            Minimal episode
          </button>
          <button type="button" className="btn" onClick={() => load(examples.full)}>
            Full episode
          </button>
          <button type="button" className="btn" onClick={() => load("")}>
            Clear
          </button>
        </div>
        <textarea
          ref={area}
          name="episode"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          spellCheck={false}
          placeholder={'Paste or drop a story bible, episode or bundle here\n\n{ "schema_version": "2.3", "doc_type": "episode", "story_id": "...", "episode_number": 1, ... }'}
          className={`input h-[70vh] rounded-2xl p-4 font-mono text-xs leading-[18px] ${dragging ? "border-dashed border-line-hover bg-panel" : ""}`}
        />
      </div>
      <aside className="flex flex-col gap-4">
        <div className="card flex flex-col gap-3">
          <span className="eyebrow">{docType ? DOC_LABEL[docType] : legacy ? "Schema 1.0 episode" : "Status"}</span>
          <p className={`text-xl font-semibold tracking-tight ${result && !result.ok ? "text-bad" : ""}`}>{status}</p>
          {result?.needs_story && (
            <p className="text-sm text-muted">
              Story <span className="font-mono">{result.needs_story}</span> has no story bible here yet. Save its story bible
              first, or paste a bundle.
            </p>
          )}
          {legacy && (
            <button type="button" className="btn w-full" onClick={convert}>
              Convert v1 to a 2.3 bundle
            </button>
          )}
          <button type="button" className="btn-primary w-full" disabled={!result?.ok || pending || checking || planning} onClick={() => void review()}>
            {pending ? "Saving…" : planning ? "Checking…" : submitLabel}
          </button>
          {state.error && <p className="text-sm text-bad">{state.error}</p>}
        </div>
        {notes.length > 0 && (
          <div className="card flex flex-col gap-1 text-xs">
            <span className="eyebrow">Conversion notes</span>
            {notes.map((n, i) => (
              <p key={i} className="font-light text-muted">
                {n}
              </p>
            ))}
          </div>
        )}
        {est && (
          <div className="card text-sm">
            <span className="eyebrow">Estimate</span>
            <dl className="mt-3 grid grid-cols-2 gap-y-1.5">
              {(
                [
                  ["Runtime", fmtMinutes(est.total_seconds)],
                  ["Segments", est.segment_count],
                  ["Images to generate", est.images_to_generate],
                  ["Reused images", est.reused_images],
                  ["Cards", est.cards],
                  ["SFX cues", est.sfx_cues],
                  ["TTS characters", est.tts_characters.toLocaleString()],
                  ["Words", est.total_words.toLocaleString()],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-light text-muted">{k}</dt>
                  <dd className="text-right tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {result?.continuity && (
          <div className="card text-xs">
            <span className="eyebrow">Story state after this episode</span>
            <dl className="mt-3 grid grid-cols-2 gap-y-1">
              {Object.entries(result.continuity.end.locations).map(([k, v]) => (
                <div key={`l-${k}`} className="contents">
                  <dt className="font-light text-muted">{k}</dt>
                  <dd className="text-right font-mono">{v}</dd>
                </div>
              ))}
              {Object.entries(result.continuity.end.world).map(([k, v]) => (
                <div key={`w-${k}`} className="contents">
                  <dt className="font-light text-muted">{k}</dt>
                  <dd className="text-right font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {result?.structure && result.structure.roles.length > 0 && <StructurePanel report={result.structure} />}
        {result?.identification && <IdentificationPanel report={result.identification} />}
        {result && result.errors.length > 0 && <IssueList title="Errors" tone="text-bad" issues={result.errors} onJump={jump} />}
        {result && result.warnings.length > 0 && <IssueList title="Warnings" tone="text-warn" issues={result.warnings} onJump={jump} />}
      </aside>
    </form>
  );
}

function IssueList({
  title,
  tone,
  issues,
  onJump,
}: {
  title: string;
  tone: string;
  issues: ValidationIssue[];
  onJump: (i: ValidationIssue) => void;
}) {
  const groups = CATEGORY_ORDER.map((c) => [c, issues.filter((i) => (i.category ?? "general") === c)] as const).filter(
    ([, list]) => list.length > 0,
  );
  return (
    <div className="card flex max-h-[40vh] flex-col gap-1 overflow-auto text-xs">
      <span className={`eyebrow ${tone}`}>{title}</span>
      {groups.map(([category, list]) => (
        <div key={category} className="mt-2 flex flex-col gap-0.5">
          {groups.length > 1 && (
            <span className="px-2 text-[0.65rem] uppercase tracking-wide text-muted">
              {CATEGORY_LABEL[category]} ({list.length})
            </span>
          )}
          {list.map((issue, i) => (
            <button
              type="button"
              key={i}
              onClick={() => onJump(issue)}
              className="rounded-lg px-2 py-1 text-left transition-colors hover:bg-panel-hover"
              title={issue.path_text}
            >
              {issue.line ? <span className="font-mono text-muted">L{issue.line}:{issue.column} </span> : null}
              {issue.message}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

const CATEGORY_ORDER = ["general", "structure", "continuity", "voice", "crop"] as const;
const CATEGORY_LABEL: Record<(typeof CATEGORY_ORDER)[number], string> = {
  general: "Document",
  structure: "Structure and identification",
  continuity: "Continuity",
  voice: "Voice and dialogue",
  crop: "Crops",
};

const ROLE_LABEL: Record<string, string> = {
  cold_open: "Cold open",
  recap: "Recap",
  status_board: "Status board",
  main: "Main",
  cliffhanger: "Cliffhanger",
  end_card: "End card",
};

function StructurePanel({ report }: { report: StructureReport }) {
  const present = new Set(report.roles.map((r) => r.role));
  return (
    <div className="card flex flex-col gap-2 text-xs">
      <span className="eyebrow">Structure check</span>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(ROLE_LABEL)
          .filter(([role]) => role !== "main")
          .map(([role, label]) => (
            <span key={role} className={`chip ${present.has(role as SegmentRole) ? "" : "opacity-40"}`}>
              {label} {report.roles.filter((r) => r.role === role).length || ""}
            </span>
          ))}
      </div>
      {report.applies ? (
        <ul className="flex flex-col gap-1">
          {report.checks.map((c) => (
            <li key={c.id} className="flex gap-2">
              <span className={c.ok ? "text-ok" : "text-warn"}>{c.ok ? "✓" : "!"}</span>
              <span className={c.ok ? "font-light text-muted" : ""}>
                <span className="font-medium text-foreground">{c.label}.</span> {c.ok ? c.detail : c.detail.charAt(0).toUpperCase() + c.detail.slice(1)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-light text-muted">Role checks apply to schema 2.2+ episodes with structure enabled.</p>
      )}
      <ol className="flex flex-col gap-0.5 font-mono text-[0.7rem]">
        {report.roles.map((r) => (
          <li key={r.segment_id} className="flex justify-between gap-2">
            <span>
              {r.order}. {r.segment_id}
            </span>
            <span className={r.role === "main" ? "text-muted" : ""}>
              {r.role} · {Math.round(r.seconds)}s
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const POV_STATUS_LABEL: Record<PovSegment["status"], string> = {
  on_screen: "on screen",
  missing: "missing",
  exception: "exception",
  ineligible: "not counted",
};

function IdentificationPanel({ report }: { report: IdentificationReport }) {
  const pct = report.ratio === null ? null : Math.round(report.ratio * 100);
  const tone = report.ratio === null || !report.enforced ? "" : report.ratio < report.hard_min ? "text-bad" : report.ratio < report.min ? "text-warn" : "text-ok";
  const rows = report.segments.filter((s) => s.status !== "ineligible");
  return (
    <div className="card flex flex-col gap-2 text-xs">
      <span className="eyebrow">Viewer on screen</span>
      <p className={`text-lg font-semibold tabular-nums ${tone}`}>
        {pct === null ? "No present-day pictures" : `${pct}% (${report.on_screen}/${report.eligible})`}
      </p>
      <p className="font-light text-muted">
        <span className="font-mono">{report.pov_character_id}</span> in present-day pictures
        {report.enforced ? `; aim for ${Math.round(report.min * 100)}%, at least ${Math.round(report.hard_min * 100)}%.` : " (not enforced: the story has no identification block)."}
      </p>
      <ol className="flex flex-col gap-0.5 font-mono text-[0.7rem]">
        {rows.map((s) => (
          <li key={s.segment_id} className="flex justify-between gap-2" title={s.reason ?? undefined}>
            <span>{s.segment_id}</span>
            <span className={s.status === "missing" ? "text-warn" : s.status === "exception" ? "text-muted" : ""}>{POV_STATUS_LABEL[s.status]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
