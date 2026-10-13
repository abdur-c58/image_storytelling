"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { deleteProjectAction, projectAction, type ProjectAction } from "@/app/actions";

export function ActionButton({
  projectId,
  action,
  label,
  primary,
  small,
  confirm,
}: {
  projectId: string;
  action: ProjectAction;
  label: string;
  primary?: boolean;
  small?: boolean;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={pending}
        className={`${primary ? "btn-primary" : "btn"} ${small ? "px-3 py-0.5 text-xs" : ""}`}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setError(null);
          start(async () => {
            const res = await projectAction(projectId, action);
            if (res?.error) setError(res.error);
          });
        }}
      >
        {pending ? "…" : label}
      </button>
      {error && <span className="mt-1 text-xs text-bad">{error}</span>}
    </span>
  );
}

export function DeleteProjectButton({
  projectId,
  title,
  published,
  active,
}: {
  projectId: string;
  title: string;
  published: boolean;
  active: boolean;
}) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => {
    if (pending) return;
    setStep(0);
    setTyped("");
    setError(null);
  };

  useEffect(() => {
    if (step === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) {
        setStep(0);
        setTyped("");
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, pending]);

  const matches = typed.trim() === title.trim();

  return (
    <>
      <button type="button" className="btn text-bad hover:border-bad" onClick={() => setStep(1)}>
        Delete
      </button>
      {step > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-bad/40 bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="eyebrow text-bad">Step {step} of 2</span>
            <h2 id="delete-title" className="mt-2 text-2xl font-bold tracking-tight">
              {step === 1 ? "Delete this project permanently?" : "Confirm by typing the title"}
            </h2>
            {step === 1 ? (
              <>
                <p className="mt-3 text-sm font-light text-muted">This removes, with no way to undo:</p>
                <ul className="mt-2 list-disc pl-5 text-sm font-light text-muted">
                  <li>the episode, its segments, tasks and activity log</li>
                  <li>every stored file: images, voice, sound effects, thumbnail, captions and video</li>
                </ul>
                {active && (
                  <p className="mt-3 text-sm text-warn">Work is still running. Queued and in-progress tasks will be cancelled.</p>
                )}
                {published && (
                  <p className="mt-3 text-sm text-warn">
                    This episode was published. The YouTube video itself is not deleted; remove it in YouTube Studio if needed.
                  </p>
                )}
                <p className="mt-3 text-sm font-light text-muted">
                  To keep it but hide it from the list, use Archive instead.
                </p>
                <div className="mt-6 flex justify-end gap-2">
                  <button type="button" className="btn" onClick={close}>
                    Cancel
                  </button>
                  <button type="button" className="btn border-bad text-bad" onClick={() => setStep(2)}>
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!matches) return;
                  setError(null);
                  start(async () => {
                    const res = await deleteProjectAction(projectId, typed);
                    if (res?.error) setError(res.error);
                  });
                }}
              >
                <p className="mt-3 text-sm font-light text-muted">
                  Type <span className="font-semibold text-foreground">{title}</span> to delete it forever.
                </p>
                <input
                  autoFocus
                  className="input mt-3 w-full"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={title}
                  aria-label="Project title"
                  disabled={pending}
                />
                {error && <p className="mt-2 text-sm text-bad">{error}</p>}
                <div className="mt-6 flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setStep(1)} disabled={pending}>
                    Back
                  </button>
                  <button type="submit" className="btn border-bad bg-bad text-white disabled:opacity-40" disabled={!matches || pending}>
                    {pending ? "Deleting…" : "Delete forever"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function AutoRefresh({ enabled, everyMs = 5000 }: { enabled: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [enabled, everyMs, router]);
  return null;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn px-3 py-0.5 text-xs"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
