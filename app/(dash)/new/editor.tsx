"use client";

import { useActionState, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createProjectAction, validateDocumentAction, type CreateState } from "@/app/actions";
import { convertV1ToV2 } from "@/lib/episode/migrate";
import { detectDocType, parseJsonText, validateText, type ValidationIssue, type ValidationResult } from "@/lib/episode/validate";
import { DRAFT_KEY } from "../projects/drop-import";

function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

const DOC_LABEL = { story_bible: "Story bible", episode: "Episode", bundle: "Bundle (story + episode)" } as const;

export function EpisodeEditor({
  examples,
  loadDraft,
}: {
  examples: { story: string; minimal: string; full: string };
  loadDraft: boolean;
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

  // Episodes need the stored story for continuity; ask the server once typing settles.
  const needsServer = !!local && (local.doc_type === "episode" || local.doc_type === "bundle") && !legacy;
  useEffect(() => {
    if (!needsServer) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setChecking(true);
      try {
        const result = await validateDocumentAction(deferred);
        if (!cancelled) setServer({ text: deferred, result });
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deferred, needsServer]);

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
  const submitLabel = docType === "story_bible" ? "Save story" : docType === "bundle" ? "Save story + create project" : "Create project";
  const status = !local
    ? "Waiting for JSON"
    : !result
      ? "Checking continuity…"
      : result.ok
        ? "Valid"
        : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`;
  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[1fr_360px]">
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
          placeholder={'Paste or drop a story bible, episode or bundle here\n\n{ "schema_version": "2.0", "doc_type": "episode", ... }'}
          className={`input h-[70vh] rounded-2xl p-4 font-mono text-xs leading-[18px] ${dragging ? "border-dashed border-line-hover bg-panel" : ""}`}
        />
      </div>
      <aside className="flex flex-col gap-4">
        <div className="card flex flex-col gap-3">
          <span className="eyebrow">{docType ? DOC_LABEL[docType] : legacy ? "Schema 1.0 episode" : "Status"}</span>
          <p className={`text-xl font-semibold tracking-tight ${result && !result.ok ? "text-bad" : ""}`}>{status}</p>
          {result?.needs_story && (
            <p className="text-sm text-muted">
              Story <span className="font-mono">{result.needs_story}</span> isn&apos;t stored yet. Save its story bible first,
              or paste a bundle.
            </p>
          )}
          {legacy && (
            <button type="button" className="btn w-full" onClick={convert}>
              Convert v1 to a 2.0 bundle
            </button>
          )}
          <button className="btn-primary w-full" disabled={!result?.ok || pending || checking}>
            {pending ? "Saving…" : submitLabel}
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
  return (
    <div className="card flex max-h-[40vh] flex-col gap-1 overflow-auto text-xs">
      <span className={`eyebrow ${tone}`}>{title}</span>
      <div className="mt-2 flex flex-col gap-0.5">
        {issues.map((issue, i) => (
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
    </div>
  );
}
