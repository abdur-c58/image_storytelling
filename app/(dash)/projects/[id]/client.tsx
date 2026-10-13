"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { projectAction, type ProjectAction } from "@/app/actions";

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
