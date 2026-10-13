"use client";

import { useActionState, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { createProjectAction, type CreateState } from "@/app/actions";
import { validateEpisodeText, type ValidationIssue } from "@/lib/episode/validate";
import { DRAFT_KEY } from "../projects/drop-import";

function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}m ${Math.round(sec % 60)}s`;
}

export function EpisodeEditor({ examples, loadDraft }: { examples: { minimal: string; full: string }; loadDraft: boolean }) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const result = useMemo(() => (deferred.trim() ? validateEpisodeText(deferred) : null), [deferred]);
  const [state, action, pending] = useActionState<CreateState, FormData>(createProjectAction, { error: null });
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

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
    setText(await file.text());
  };

  const est = result?.estimate;
  return (
    <form action={action} className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={() => setText(examples.minimal)}>
            Minimal example
          </button>
          <button type="button" className="btn" onClick={() => setText(examples.full)}>
            Full example
          </button>
          <button type="button" className="btn" onClick={() => setText("")}>
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
          placeholder={'Paste or drop the episode JSON here\n\n{ "schema_version": "1.0", ... }'}
          className={`input h-[70vh] rounded-2xl p-4 font-mono text-xs leading-[18px] ${dragging ? "border-dashed border-line-hover bg-panel" : ""}`}
        />
      </div>
      <aside className="flex flex-col gap-4">
        <div className="card flex flex-col gap-3">
          <span className="eyebrow">Status</span>
          <p className={`text-xl font-semibold tracking-tight ${result && !result.ok ? "text-bad" : ""}`}>
            {!result ? "Waiting for JSON" : result.ok ? "Valid" : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`}
          </p>
          <button className="btn-primary w-full" disabled={!result?.ok || pending}>
            {pending ? "Creating…" : "Create project"}
          </button>
          {state.error && <p className="text-sm text-bad">{state.error}</p>}
        </div>
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
