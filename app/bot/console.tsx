"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const HEADERS = { "x-bot-console": "1" };
const DIRECT_UPLOAD_MAX = 4_000_000;
const STORAGE_KEY = "bot-console-task";

interface ImageItem {
  segment_id: string;
  asset_key: string;
  final_prompt: string;
  negative_prompt: string;
  reference_image_urls: string[];
  aspect_ratio: string;
  output_filename: string;
  already_uploaded?: boolean;
}

interface Task {
  task_id: string;
  type: "generate_images" | "upload_youtube";
  scope: string;
  lease_id: string;
  lease_expires_at: string;
  heartbeat_every_seconds?: number;
  project_title?: string;
  payload: Record<string, unknown>;
  items_status?: { asset_key: string; uploaded: boolean }[];
}

type ItemState = { status: "idle" | "uploading" | "done" | "error"; message?: string };

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(path, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) } });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function BotConsole({ resumeTask, resumeLease }: { resumeTask: string | null; resumeLease: string | null }) {
  const [task, setTask] = useState<Task | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const load = useCallback(async (taskId: string, leaseId: string) => {
    try {
      const t = (await api(`/api/bot/tasks/${taskId}?lease_id=${encodeURIComponent(leaseId)}`)) as Task;
      setTask(t);
      const done: Record<string, ItemState> = {};
      for (const s of t.items_status ?? []) if (s.uploaded) done[s.asset_key] = { status: "done" };
      setItems(done);
    } catch (e) {
      sessionStorage.removeItem(STORAGE_KEY);
      setMessage(`Could not resume task: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    const [taskId, leaseId] = resumeTask && resumeLease ? [resumeTask, resumeLease] : saved ? JSON.parse(saved) : [null, null];
    if (taskId && leaseId) void load(taskId, leaseId);
  }, [resumeTask, resumeLease, load]);

  useEffect(() => {
    if (!task) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([task.task_id, task.lease_id]));
    const every = Math.max(20, task.heartbeat_every_seconds ?? 120) * 1000;
    const timer = setInterval(async () => {
      const list = (task.payload.items as ImageItem[] | undefined) ?? [];
      const completed = list.filter((i) => itemsRef.current[i.asset_key]?.status === "done").length;
      try {
        await api(`/api/bot/tasks/${task.task_id}/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lease_id: task.lease_id, progress: { completed_items: completed, total_items: list.length } }),
        });
      } catch (e) {
        setMessage(`Heartbeat failed: ${(e as Error).message}. Stop work on this task.`);
      }
    }, every);
    return () => clearInterval(timer);
  }, [task]);

  const claim = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const t = (await api("/api/bot/tasks/next")) as Task | null;
      if (!t) setMessage("No work available right now.");
      else {
        setTask(t);
        const done: Record<string, ItemState> = {};
        for (const i of (t.payload.items as ImageItem[] | undefined) ?? []) if (i.already_uploaded) done[i.asset_key] = { status: "done" };
        setItems(done);
      }
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (item: ImageItem, file: File) => {
    if (!task) return;
    setItems((s) => ({ ...s, [item.asset_key]: { status: "uploading" } }));
    try {
      let result: { accepted: boolean; reason: string | null };
      if (file.size <= DIRECT_UPLOAD_MAX) {
        const form = new FormData();
        form.set("lease_id", task.lease_id);
        form.set("asset_key", item.asset_key);
        form.set("file", file);
        result = await api(`/api/bot/tasks/${task.task_id}/assets`, { method: "POST", body: form });
      } else {
        const slot = await api(`/api/bot/tasks/${task.task_id}/upload-url`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lease_id: task.lease_id, asset_key: item.asset_key, content_type: file.type || "image/png", size_bytes: file.size }),
        });
        if (slot.upload_url) {
          const put = await fetch(slot.upload_url, { method: "PUT", body: file, headers: { "content-type": file.type || "image/png" } });
          if (!put.ok) throw new Error(`Storage upload failed (HTTP ${put.status}).`);
        }
        result = await api(`/api/bot/tasks/${task.task_id}/assets/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lease_id: task.lease_id, asset_id: slot.asset_id }),
        });
      }
      setItems((s) => ({
        ...s,
        [item.asset_key]: result.accepted ? { status: "done" } : { status: "error", message: result.reason ?? "Rejected." },
      }));
    } catch (e) {
      setItems((s) => ({ ...s, [item.asset_key]: { status: "error", message: (e as Error).message } }));
    }
  };

  const finish = async (body: Record<string, unknown>) => {
    if (!task) return;
    setBusy(true);
    try {
      const res = await api(`/api/bot/tasks/${task.task_id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lease_id: task.lease_id, result: body }),
      });
      setMessage(res?.missing?.length ? `Completed. Missing items will be re-queued: ${res.missing.join(", ")}` : "Completed.");
      sessionStorage.removeItem(STORAGE_KEY);
      setTask(null);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const failTask = async () => {
    if (!task) return;
    const reason = window.prompt("What went wrong? (sent to the operator)");
    if (!reason) return;
    const retryable = window.confirm("Should the task be retried later? OK = retry, Cancel = give up permanently.");
    setBusy(true);
    try {
      await api(`/api/bot/tasks/${task.task_id}/fail`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lease_id: task.lease_id, reason, retryable }),
      });
      setMessage("Reported failure.");
      sessionStorage.removeItem(STORAGE_KEY);
      setTask(null);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Bot console</h1>
        <div className="flex gap-2 text-sm">
          <a className="btn" href="/api/bot/runbook" target="_blank">
            Runbook
          </a>
          <form action="/api/auth/logout" method="post">
            <button className="btn">Sign out</button>
          </form>
        </div>
      </div>
      {message && <p className="card text-sm">{message}</p>}
      {!task && (
        <button className="btn-primary self-start" onClick={claim} disabled={busy}>
          {busy ? "Checking…" : "Claim next task"}
        </button>
      )}
      {task && (
        <div className="card flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">
                {task.type} · {task.scope}
              </div>
              <div className="text-xs text-muted">
                {task.project_title} · task {task.task_id} · lease expires {new Date(task.lease_expires_at).toLocaleTimeString()} (renewed
                automatically while this page is open)
              </div>
            </div>
            <button className="btn" onClick={failTask} disabled={busy}>
              Report failure
            </button>
          </div>
          {task.type === "generate_images" ? (
            <ImagesTask task={task} items={items} onUpload={upload} onComplete={() => finish({})} busy={busy} />
          ) : (
            <PublishTask task={task} onComplete={finish} busy={busy} />
          )}
        </div>
      )}
    </div>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn px-2 py-0.5 text-xs"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function ImagesTask({
  task,
  items,
  onUpload,
  onComplete,
  busy,
}: {
  task: Task;
  items: Record<string, ItemState>;
  onUpload: (item: ImageItem, file: File) => void;
  onComplete: () => void;
  busy: boolean;
}) {
  const list = (task.payload.items as ImageItem[]) ?? [];
  const done = list.filter((i) => items[i.asset_key]?.status === "done").length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Generate each image in {String(task.payload.image_provider ?? "the image tool")} at {String((task.payload.style_bible as { aspect_ratio?: string })?.aspect_ratio ?? "16:9")}, using the prompt exactly as written,
        then upload it here. {done}/{list.length} uploaded.
      </p>
      {list.map((item) => {
        const state = items[item.asset_key] ?? { status: "idle" };
        return (
          <div key={item.asset_key} className="rounded-xl border border-line p-3 text-sm">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono">
                {item.segment_id} → {item.output_filename}
              </span>
              <span
                className={
                  state.status === "done" ? "text-ok" : state.status === "error" ? "text-bad" : "text-muted"
                }
              >
                {state.status === "done" ? "uploaded" : state.status === "uploading" ? "uploading…" : state.status === "error" ? "rejected" : "waiting"}
              </span>
            </div>
            <div className="flex items-start gap-2">
              <p className="flex-1 whitespace-pre-wrap text-xs">{item.final_prompt}</p>
              <Copy text={item.final_prompt} />
            </div>
            {item.negative_prompt && (
              <div className="mt-1 flex items-start gap-2 text-xs text-muted">
                <p className="flex-1">Avoid: {item.negative_prompt}</p>
                <Copy text={item.negative_prompt} />
              </div>
            )}
            {item.reference_image_urls.length > 0 && (
              <div className="mt-1 flex gap-2 text-xs">
                Reference images:
                {item.reference_image_urls.map((u, i) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer" className="underline">
                    #{i + 1}
                  </a>
                ))}
              </div>
            )}
            {state.message && <p className="mt-1 text-xs text-bad">{state.message}</p>}
            {state.status !== "done" && (
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="mt-2 text-xs"
                disabled={state.status === "uploading"}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onUpload(item, file);
                  e.target.value = "";
                }}
              />
            )}
          </div>
        );
      })}
      <button
        className="btn-primary self-start"
        disabled={busy}
        onClick={() => {
          if (done < list.length && !window.confirm(`${list.length - done} image(s) are not uploaded. Complete anyway? They will be re-queued.`)) return;
          onComplete();
        }}
      >
        Complete task
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  const text = Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value);
  return (
    <div className="flex items-start gap-2 border-t border-line py-1.5 text-sm">
      <span className="w-48 shrink-0 text-muted">{label}</span>
      <span className="flex-1 whitespace-pre-wrap break-words">{text || <span className="text-muted">(none)</span>}</span>
      {text && <Copy text={text} />}
    </div>
  );
}

function PublishTask({ task, onComplete, busy }: { task: Task; onComplete: (r: Record<string, unknown>) => void; busy: boolean }) {
  const p = task.payload as Record<string, unknown>;
  const [url, setUrl] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-warn">
        Copy every field exactly. Do not edit the title or description, do not change visibility, and do not add anything
        that is not listed here.
      </p>
      <div className="flex flex-wrap gap-2 text-sm">
        {typeof p.video_download_url === "string" && (
          <a className="btn" href={p.video_download_url}>
            Download video ({String(p.video_filename)})
          </a>
        )}
        {typeof p.thumbnail_download_url === "string" && (
          <a className="btn" href={p.thumbnail_download_url}>
            Download thumbnail
          </a>
        )}
      </div>
      <Field label="Title" value={p.title} />
      <Field label="Description" value={p.description} />
      <Field label="Tags" value={p.tags} />
      <Field label="Category" value={p.category} />
      <Field label="Language" value={p.language} />
      <Field label="Visibility" value={p.visibility} />
      {p.scheduled_publish_at ? <Field label="Scheduled for (UTC)" value={p.scheduled_publish_at} /> : null}
      <Field label="Playlist" value={p.playlist} />
      <Field label="Made for kids" value={p.made_for_kids ? "Yes" : "No"} />
      <Field label="Altered or synthetic content" value={p.contains_altered_or_synthetic_media ? "Yes" : "No"} />
      <Field label="Comments" value={p.comments_enabled ? "On" : "Off"} />
      <Field label="Pinned comment" value={p.pinned_comment} />
      <Field label="End screen" value={p.end_screen_note} />
      <div className="mt-2 flex gap-2">
        <input
          className="input flex-1"
          placeholder="https://youtu.be/… (the published video URL)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="btn-primary"
          disabled={busy || !url}
          onClick={() => onComplete({ youtube_url: url.trim(), visibility_set: p.visibility })}
        >
          Mark published
        </button>
      </div>
    </div>
  );
}
