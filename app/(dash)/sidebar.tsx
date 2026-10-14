"use client";

import { ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { BUCKET_DOT, BUCKET_LABEL, type StatusBucket } from "@/lib/episode/status";

export interface SidebarStory {
  id: string;
  title: string;
  status: string;
  episodes: { number: number; title: string; bucket: StatusBucket | null }[];
}

const OPEN_KEY = "slideshow:sidebar-open";
const EXPANDED_KEY = "slideshow:sidebar-expanded";

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

/** Collapsible story → episode tree with status dots. Arrow keys move through it; state survives reloads. */
export function SidebarTree({ stories }: { stories: SidebarStory[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const tree = useRef<HTMLUListElement>(null);
  const currentStory = /^\/stories\/([^/]+)/.exec(pathname)?.[1];

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- restoring persisted UI state after hydration */
    setOpen(readJson(OPEN_KEY, true));
    setExpanded(readJson<string[]>(EXPANDED_KEY, []));
    setLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(OPEN_KEY, JSON.stringify(open));
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  }, [open, expanded, loaded]);

  const isExpanded = (id: string) => expanded.includes(id) || decodeURIComponent(currentStory ?? "") === id;
  const toggle = (id: string, to?: boolean) =>
    setExpanded((list) => {
      const next = to ?? !isExpanded(id);
      return next ? [...new Set([...list, id])] : list.filter((x) => x !== id);
    });

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(tree.current?.querySelectorAll<HTMLElement>("[data-tree-item]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const el = items[i];
    const storyId = el.dataset.story!;
    const isStory = el.dataset.level === "1";
    const move = (j: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, j))]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "ArrowRight" && isStory) {
      e.preventDefault();
      if (!isExpanded(storyId)) toggle(storyId, true);
      else move(i + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (isStory) toggle(storyId, false);
      else items.find((x) => x.dataset.level === "1" && x.dataset.story === storyId)?.focus();
    }
  };

  if (!open) {
    return (
      <aside className="hidden shrink-0 border-r border-line pt-6 lg:block">
        <button type="button" className="mx-2 rounded-lg p-2 text-muted hover:text-foreground" aria-label="Show story tree" onClick={() => setOpen(true)}>
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="hidden w-64 shrink-0 border-r border-line lg:block" aria-label="Stories">
      <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-3 py-6">
        <div className="mb-3 flex items-center justify-between px-2">
          <Link href="/stories" className="eyebrow hover:text-foreground">
            Stories
          </Link>
          <button type="button" className="rounded-lg p-1 text-muted hover:text-foreground" aria-label="Hide story tree" onClick={() => setOpen(false)}>
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
        {stories.length === 0 && <p className="px-2 text-sm text-muted">No stories yet.</p>}
        <ul ref={tree} role="tree" aria-label="Stories and episodes" className="flex flex-col gap-0.5 text-sm" onKeyDown={onKeyDown}>
          {stories.map((s, si) => {
            const exp = isExpanded(s.id);
            const storyHref = `/stories/${encodeURIComponent(s.id)}`;
            const here = pathname === storyHref;
            return (
              <li key={s.id} role="treeitem" aria-expanded={s.episodes.length ? exp : undefined} aria-selected={here} aria-level={1}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    className={`rounded p-0.5 text-muted hover:text-foreground ${s.episodes.length ? "" : "invisible"}`}
                    onClick={() => toggle(s.id)}
                  >
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${exp ? "rotate-90" : ""}`} />
                  </button>
                  <Link
                    href={storyHref}
                    data-tree-item
                    data-level="1"
                    data-story={s.id}
                    tabIndex={si === 0 ? 0 : -1}
                    className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-line-hover ${
                      here ? "bg-panel text-foreground" : "text-muted hover:text-foreground"
                    } ${s.status === "archived" ? "italic" : ""}`}
                    title={s.status === "archived" ? `${s.title} (archived)` : s.title}
                  >
                    {s.title}
                  </Link>
                </div>
                {exp && s.episodes.length > 0 && (
                  <ul role="group" className="ml-5 flex flex-col gap-0.5 border-l border-line pl-2">
                    {s.episodes.map((e) => {
                      const href = `${storyHref}/episodes/${e.number}`;
                      const on = pathname === href;
                      return (
                        <li key={e.number} role="treeitem" aria-selected={on} aria-level={2}>
                          <Link
                            href={href}
                            data-tree-item
                            data-level="2"
                            data-story={s.id}
                            tabIndex={-1}
                            className={`flex items-center gap-2 rounded-lg px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-line-hover ${
                              on ? "bg-panel text-foreground" : "text-muted hover:text-foreground"
                            }`}
                            title={e.bucket ? BUCKET_LABEL[e.bucket] : "No active version"}
                          >
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${e.bucket ? BUCKET_DOT[e.bucket] : "border border-line-hover"}`} aria-hidden />
                            <span className="truncate">
                              {e.number}. {e.title}
                            </span>
                            <span className="sr-only">({e.bucket ? BUCKET_LABEL[e.bucket] : "no active version"})</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
