"use client";

import { useEffect, useState, useTransition } from "react";
import { deleteStoryAction, storyAction, type StoryAction } from "@/app/actions";
import type { PromptPart } from "@/lib/episode/prompt";
import { PromptInspector } from "../../projects/[id]/inspect";

export interface MasterView {
  key: string;
  kind: string;
  label: string;
  status: string;
  prompt: string;
  negative: string | null;
  parts: PromptPart[];
  mustMatch: string[];
  approvedAssetId: string | null;
  candidates: { id: string; url: string; width: number | null; createdAt: string; lowRes: boolean }[];
}

export function StoryActionButton({
  storyId,
  action,
  label,
  primary,
  small,
  confirm,
}: {
  storyId: string;
  action: StoryAction;
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
            const res = await storyAction(storyId, action);
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

export interface CastView {
  id: string;
  name: string;
  role: string;
  scope: "story" | "channel" | null;
  status: string | null;
  lastSeen: number | null;
  voiceId: string;
  voiceGroup: string | null;
  canSpeak: boolean;
  sampleUrl: string | null;
  sheets: { key: string; url: string; approved: boolean }[];
}

const CHARACTER_TONE: Record<string, string> = {
  with_protagonist: "text-ok",
  returned: "text-ok",
  unknown: "text-muted",
  separated: "text-warn",
  missing: "text-warn",
  captive: "text-warn",
  deceased: "text-bad",
};

export function CastPanel({ storyId, cast }: { storyId: string; cast: CastView[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1">Character</th>
            <th>Status</th>
            <th>Voice</th>
            <th>Voice test</th>
            <th>Sheets</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cast.map((c) => (
            <tr key={c.id} className="border-t border-line align-top">
              <td className="py-2 pr-3">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="font-mono text-muted">{c.id}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <span className="chip text-muted">{c.role}</span>
                  {c.scope && <span className={`chip ${c.scope === "channel" ? "text-info" : "text-muted"}`}>{c.scope}</span>}
                </div>
              </td>
              <td className="pr-3">
                {c.status ? <span className={`chip ${CHARACTER_TONE[c.status] ?? ""}`}>{c.status.replace(/_/g, " ")}</span> : <span className="text-muted">–</span>}
                {c.lastSeen !== null && <p className="mt-1 text-muted">last seen ep {c.lastSeen}</p>}
              </td>
              <td className="pr-3">
                {c.canSpeak ? (
                  <>
                    <p className="font-mono">{c.voiceId || <span className="text-muted">worker default</span>}</p>
                    {c.voiceGroup && <p className="text-muted">group {c.voiceGroup}</p>}
                  </>
                ) : (
                  <span className="text-muted">no voice (can&apos;t speak lines)</span>
                )}
              </td>
              <td className="min-w-56 pr-3">
                {c.canSpeak && (
                  <div className="flex flex-col gap-1">
                    {c.sampleUrl && <audio src={c.sampleUrl} controls preload="none" className="h-7 w-full" />}
                    <StoryActionButton storyId={storyId} action={{ kind: "test_voice", speaker: c.id }} label={c.sampleUrl ? "New test" : "Test voice"} small />
                  </div>
                )}
              </td>
              <td className="pr-3">
                <div className="flex gap-1">
                  {c.sheets.map((s) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={s.key}
                      src={s.url}
                      alt={s.key}
                      title={`${s.key}${s.approved ? "" : " (not approved)"}`}
                      className={`h-12 rounded-md border object-cover ${s.approved ? "border-line" : "border-warn opacity-70"}`}
                    />
                  ))}
                </div>
              </td>
              <td className="py-2">
                {c.scope === "story" && (
                  <StoryActionButton
                    storyId={storyId}
                    action={{ kind: "promote_character", characterId: c.id }}
                    label="Add to channel cast"
                    small
                    confirm={`Make ${c.name} a recurring channel character? Later stories reuse their look and voice, and this can't be undone.`}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  missing: "text-muted",
  requested: "text-info",
  generated: "text-warn",
  approved: "text-ok",
};

export function MasterCard({ storyId, master }: { storyId: string; master: MasterView }) {
  const [selected, setSelected] = useState<string | null>(master.approvedAssetId ?? master.candidates[0]?.id ?? null);
  const shown = master.candidates.find((c) => c.id === selected) ?? master.candidates[0];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{master.label}</p>
          <p className="truncate font-mono text-muted">{master.key}</p>
        </div>
        <span className={`chip ${STATUS_TONE[master.status] ?? ""}`}>{master.status}</span>
      </div>
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.url} alt={master.label} className="aspect-video w-full rounded-lg border border-line object-cover" />
      ) : (
        <div className="dot-grid flex aspect-video items-center justify-center rounded-lg border border-line text-muted">
          {master.status === "requested" ? "waiting for the bot" : "no image"}
        </div>
      )}
      {master.candidates.length > 1 && (
        <div className="flex gap-1">
          {master.candidates.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={`w-1/4 overflow-hidden rounded-md border ${c.id === shown?.id ? "border-foreground" : "border-line"}`}
              title={`Candidate ${i + 1}${c.id === master.approvedAssetId ? " (approved)" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.url} alt={`Candidate ${i + 1}`} className="aspect-video w-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {shown?.lowRes && <p className="text-warn">Narrower than the story&apos;s minimum width; it will be upscaled.</p>}
      {master.mustMatch.length > 0 && (
        <p className="text-muted">
          <span className="text-foreground">Must match:</span> {master.mustMatch.join(" · ")}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-muted">prompt</summary>
        {master.parts.length ? (
          <PromptInspector parts={master.parts} masterKeys={[]} negative={master.negative} />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-muted">{master.prompt}</p>
        )}
      </details>
      <div className="flex flex-wrap gap-1">
        {shown && shown.id !== master.approvedAssetId && (
          <StoryActionButton
            storyId={storyId}
            action={{ kind: "approve_master", masterKey: master.key, assetId: shown.id }}
            label="Approve"
            primary
            small
          />
        )}
        {master.status !== "requested" && (
          <StoryActionButton
            storyId={storyId}
            action={{ kind: "regen_master", masterKey: master.key }}
            label="Regenerate"
            small
            confirm={master.status === "approved" ? "Drop the approved image and ask the bot for a new one? Episodes waiting on this master will wait again." : undefined}
          />
        )}
      </div>
    </div>
  );
}

export function DeleteStoryButton({ storyId, episodes }: { storyId: string; episodes: number }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !pending && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending]);
  return (
    <>
      <button type="button" className="btn text-bad hover:border-bad" onClick={() => setOpen(true)}>
        Delete story
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !pending && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-lg rounded-2xl border border-bad/40 bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-2xl font-bold tracking-tight">Delete this story?</h2>
            {episodes > 0 ? (
              <p className="mt-3 text-sm text-warn">
                It still has {episodes} episode{episodes === 1 ? "" : "s"}. Delete those projects first.
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setError(null);
                  start(async () => {
                    const res = await deleteStoryAction(storyId, typed);
                    if (res?.error) setError(res.error);
                  });
                }}
              >
                <p className="mt-3 text-sm font-light text-muted">
                  This removes the story bible, its story state and every master image. Type{" "}
                  <span className="font-mono text-foreground">{storyId}</span> to confirm.
                </p>
                <input autoFocus className="input mt-3 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={pending} />
                {error && <p className="mt-2 text-sm text-bad">{error}</p>}
                <div className="mt-6 flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
                    Cancel
                  </button>
                  <button type="submit" className="btn border-bad bg-bad text-white disabled:opacity-40" disabled={typed.trim() !== storyId || pending}>
                    {pending ? "Deleting…" : "Delete forever"}
                  </button>
                </div>
              </form>
            )}
            {episodes > 0 && (
              <div className="mt-6 flex justify-end">
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
