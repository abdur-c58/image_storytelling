"use client";

import { FolderPlus } from "lucide-react";
import { useState, useTransition } from "react";
import { createStoryAction } from "@/app/actions";
import { isStorySlug, slugify } from "@/lib/episode/naming";

/** "New story": name, then an editable slug (the `story_id` every document for this story must carry). */
export function NewStoryButton({ initialSlug = null }: { initialSlug?: string | null }) {
  const [open, setOpen] = useState(!!initialSlug);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState(initialSlug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!initialSlug);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const effectiveSlug = slugTouched ? slug : slugify(title);
  const valid = title.trim().length > 0 && isStorySlug(effectiveSlug);

  const submit = () =>
    start(async () => {
      setError(null);
      const res = await createStoryAction({ title: title.trim(), slug: effectiveSlug, description: description.trim() || undefined });
      if (res?.error) setError(res.error);
    });

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        <FolderPlus className="h-4 w-4" /> New story
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm" onClick={() => !pending && setOpen(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-story-title"
            className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-line bg-background p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) submit();
            }}
          >
            <h2 id="new-story-title" className="text-2xl font-bold tracking-tight">
              New story
            </h2>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Name</span>
              <input autoFocus className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The Rising" maxLength={120} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Story id (slug, can&apos;t be changed later)</span>
              <input
                className="input font-mono"
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="the_rising"
                aria-invalid={!!effectiveSlug && !isStorySlug(effectiveSlug)}
              />
              {effectiveSlug && !isStorySlug(effectiveSlug) && (
                <span className="text-xs text-bad">Lowercase letters, digits, - and _ only; start with a letter or digit.</span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">Description (optional)</span>
              <textarea className="input h-20" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
            </label>
            <p className="text-xs font-light text-muted">
              The folder starts empty. Paste the story bible (with <code className="font-mono">story_id: &quot;{effectiveSlug || "…"}&quot;</code>) before
              adding episodes.
            </p>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!valid || pending}>
                {pending ? "Creating…" : "Create story"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
