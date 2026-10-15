"use client";

import { useEffect, useState, useTransition } from "react";
import { deleteStoryAction, storyAction, type StoryAction } from "@/app/actions";
import type { PromptPart } from "@/lib/episode/prompt";
import type { VoiceSource } from "@/lib/pipeline/voices";
import { MediaPlayer } from "../../media";
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
  voiceSource: VoiceSource | null;
  /** voice_id set on this page for this story ("" = none). */
  voiceOverride: string;
  voiceGroup: string | null;
  canSpeak: boolean;
  sampleUrl: string | null;
  sampleId: string | null;
  /** The latest voice test that hasn't produced a sample yet (queued, recording or failed). */
  sampleStatus: { tone: "muted" | "info" | "bad"; text: string } | null;
  sheets: { key: string; url: string; approved: boolean }[];
}

const SAMPLE_TONE = { muted: "text-muted", info: "text-info", bad: "text-bad" } as const;

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
                    <VoiceIdEditor storyId={storyId} cast={c} />
                    {c.voiceGroup && <p className="text-muted">group {c.voiceGroup}</p>}
                  </>
                ) : (
                  <span className="text-muted">no voice (can&apos;t speak lines)</span>
                )}
              </td>
              <td className="min-w-56 pr-3">
                {c.canSpeak && (
                  <div className="flex flex-col gap-1">
                    {c.sampleUrl && <MediaPlayer kind="audio" id={c.sampleId ?? c.id} src={c.sampleUrl} />}
                    <StoryActionButton storyId={storyId} action={{ kind: "test_voice", speaker: c.id }} label={c.sampleUrl ? "New test" : "Test voice"} small />
                    {c.sampleStatus && <p className={`max-w-64 break-words ${SAMPLE_TONE[c.sampleStatus.tone]}`}>{c.sampleStatus.text}</p>}
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

const VOICE_SOURCE_LABEL: Record<VoiceSource, string> = {
  story_page: "set here",
  channel_settings: "channel voice (Settings)",
  story_json: "from the story JSON",
  default_settings: "default voice (Settings)",
  worker_env: "worker FISH_VOICE_ID",
};

function VoiceIdEditor({ storyId, cast }: { storyId: string; cast: CastView }) {
  const [value, setValue] = useState(cast.voiceOverride);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = (voiceId: string) =>
    start(async () => {
      const res = await storyAction(storyId, { kind: "set_voice", speaker: cast.id, voiceId });
      setError(res.error);
      if (!res.error) setValue(voiceId);
    });
  const dirty = value.trim() !== cast.voiceOverride;
  return (
    <div className="flex min-w-60 flex-col gap-1">
      <p className="font-mono">{cast.voiceId || <span className="text-muted">none</span>}</p>
      {cast.voiceSource && <p className="text-muted">{VOICE_SOURCE_LABEL[cast.voiceSource]}</p>}
      <div className="flex gap-1">
        <input
          className="input h-7 flex-1 py-0 font-mono text-xs"
          placeholder="New voice id for this story"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && dirty && save(value)}
        />
        {dirty && (
          <button className="btn px-2 py-0.5 text-xs" disabled={pending} onClick={() => save(value)}>
            Save
          </button>
        )}
        {!dirty && cast.voiceOverride && (
          <button className="btn px-2 py-0.5 text-xs" disabled={pending} onClick={() => save("")} title="Go back to the story JSON or Settings voice">
            Clear
          </button>
        )}
      </div>
      {error && <p className="text-bad">{error}</p>}
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
        <span className={`chip ${STATUS_TONE[master.status] ?? ""}`}>{master.status === "missing" ? "not needed yet" : master.status}</span>
      </div>
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown.url} alt={master.label} className="aspect-video w-full rounded-lg border border-line object-cover" />
      ) : (
        <div className="dot-grid flex aspect-video items-center justify-center rounded-lg border border-line text-muted">
          {master.status === "requested" ? "waiting for the bot" : "made when an episode needs it"}
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
            label={master.status === "missing" && !master.candidates.length ? "Make now" : "Regenerate"}
            small
            confirm={master.status === "approved" ? "Drop the approved image and ask the bot for a new one? Episodes waiting on this master will wait again." : undefined}
          />
        )}
      </div>
    </div>
  );
}

/** Move to the trash (30-day restore), or delete forever from the trash. Both need the story's name typed. */
export function DeleteStoryButton({
  storyId,
  title,
  episodes,
  forever = false,
}: {
  storyId: string;
  title: string;
  episodes: number;
  forever?: boolean;
}) {
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
        {forever ? "Delete forever" : "Move to trash"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !pending && setOpen(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-story-title"
            className="w-full max-w-lg rounded-2xl border border-bad/40 bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              start(async () => {
                const res = await deleteStoryAction(storyId, typed, forever);
                if (res?.error) setError(res.error);
              });
            }}
          >
            <h2 id="delete-story-title" className="text-2xl font-bold tracking-tight">
              {forever ? "Delete this story forever?" : "Move this story to the trash?"}
            </h2>
            <p className="mt-3 text-sm font-light text-muted">
              {forever
                ? `This removes the story bible, its ${episodes} episode${episodes === 1 ? "" : "s"} with every version, rendered files and master images. It can't be undone.`
                : `Its ${episodes} episode${episodes === 1 ? "" : "s"} stop and queued bot tasks are cancelled. You can restore it from the trash for 30 days; after that it is deleted with all files.`}{" "}
              Type <span className="font-mono text-foreground">{title}</span> to confirm.
            </p>
            <input autoFocus className="input mt-3 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={pending} aria-label="Story name" />
            {error && <p className="mt-2 text-sm text-bad">{error}</p>}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className="btn border-bad bg-bad text-white disabled:opacity-40" disabled={typed.trim() !== title.trim() || pending}>
                {pending ? "Deleting…" : forever ? "Delete forever" : "Move to trash"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export function RestoreStoryButton({ storyId }: { storyId: string }) {
  return <StoryActionButton storyId={storyId} action={{ kind: "restore" }} label="Restore" primary />;
}

/** Rename (title only; the story_id never changes), description and per-story default overrides. */
export function StorySettingsForm({
  storyId,
  title,
  description,
  defaultsOverride,
}: {
  storyId: string;
  title: string;
  description: string;
  defaultsOverride: string;
}) {
  const [name, setName] = useState(title);
  const [desc, setDesc] = useState(description);
  const [overrides, setOverrides] = useState(defaultsOverride);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      let parsed: unknown = {};
      try {
        parsed = overrides.trim() ? JSON.parse(overrides) : {};
      } catch {
        setError("Default overrides must be valid JSON.");
        return;
      }
      if (name.trim() !== title) {
        const res = await storyAction(storyId, { kind: "rename", title: name.trim() });
        if (res.error) return setError(res.error);
      }
      const res = await storyAction(storyId, { kind: "settings", description: desc, defaultsOverride: parsed });
      if (res.error) return setError(res.error);
      setSaved(true);
    });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <span className="text-xs font-light text-muted">
          Only the display title changes. The story id <span className="font-mono">{storyId}</span> stays, and episodes keep referring to it.
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Description</span>
        <textarea className="input h-24" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">Default overrides (JSON, merged over the bible&apos;s defaults for new episodes)</span>
        <textarea
          className="input h-40 font-mono text-xs"
          value={overrides}
          onChange={(e) => setOverrides(e.target.value)}
          spellCheck={false}
          placeholder='{ "audio": { "music_bed": "none" } }'
        />
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      {saved && !error && <p className="text-sm text-ok">Saved.</p>}
      <div>
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
