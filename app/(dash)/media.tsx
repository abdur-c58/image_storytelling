"use client";

import { useCallback, useRef, useState } from "react";

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const Play = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);
const Pause = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />
  </svg>
);
const Speaker = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" stroke="none" />
    {muted ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" />}
  </svg>
);
const Expand = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
  </svg>
);

/**
 * Audio/video player for signed storage links. The pages refresh every few seconds and every
 * refresh signs a new link for the same file; a native <audio src> would restart on each one.
 * This keeps the link it started with until `id` (the asset) changes, and only switches to the
 * newest link if the old one stops working (expired), resuming where it was.
 * `start`/`end` (seconds) limit playback to one window of the file, e.g. a single dialogue line.
 */
export function MediaPlayer({
  kind,
  id,
  src,
  start,
  end,
  className = "",
}: {
  kind: "audio" | "video";
  id: string;
  src: string;
  start?: number;
  end?: number;
  className?: string;
}) {
  const ref = useRef<HTMLAudioElement & HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState({ id, url: src });
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = useRef<{ at: number; play: boolean } | null>(null);
  // The element may finish loading metadata before hydration attaches its event handlers.
  const attach = useCallback((el: (HTMLAudioElement & HTMLVideoElement) | null) => {
    ref.current = el;
    if (el && el.readyState >= 1 && Number.isFinite(el.duration)) setDuration(el.duration);
  }, []);

  if (current.id !== id) {
    setCurrent({ id, url: src });
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }

  const from = start ?? 0;
  const to = end ?? duration;
  const length = Math.max(0, to - from);
  const position = Math.min(Math.max(0, time - from), length || Infinity);

  const toggle = async () => {
    const el = ref.current;
    if (!el) return;
    if (!el.paused) {
      el.pause();
      return;
    }
    if (end !== undefined && el.currentTime >= end - 0.05) el.currentTime = from;
    else if (start !== undefined && el.currentTime < start) el.currentTime = start;
    try {
      setError(null);
      await el.play();
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Couldn't play this file.");
    }
  };

  const seek = (value: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = from + value;
    setTime(from + value);
  };

  const media = {
    ref: attach,
    src: current.url,
    preload: kind === "video" ? "metadata" : "none",
    playsInline: true,
    onPlay: () => {
      setPlaying(true);
      for (const other of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
        if (other !== ref.current && !other.paused) other.pause();
      }
    },
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onLoadedMetadata: () => {
      const el = ref.current;
      if (!el) return;
      setDuration(el.duration);
      const r = resume.current;
      resume.current = null;
      if (r) {
        el.currentTime = r.at;
        if (r.play) void el.play().catch(() => {});
      } else if (start !== undefined && el.currentTime < start) {
        el.currentTime = start;
      }
    },
    onDurationChange: () => {
      const d = ref.current?.duration;
      if (d && Number.isFinite(d)) setDuration(d);
    },
    onTimeUpdate: () => {
      const el = ref.current;
      if (!el) return;
      if (end !== undefined && el.currentTime >= end) {
        el.pause();
        el.currentTime = end;
      }
      setTime(el.currentTime);
    },
    onError: () => {
      const el = ref.current;
      // Most likely the signed link expired: switch to the newest one and carry on from here.
      if (src !== current.url) {
        resume.current = { at: el?.currentTime ?? time, play: playing };
        setCurrent({ id, url: src });
      } else {
        setPlaying(false);
        setError("Couldn't load this file. Reload the page to get a fresh link.");
      }
    },
  };

  const controls = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-foreground bg-foreground text-background transition-opacity hover:opacity-85"
      >
        {playing ? <Pause /> : <Play />}
      </button>
      <span className="w-20 shrink-0 font-mono text-[11px] text-muted tabular-nums">
        {clock(position)} / {length ? clock(length) : "–:––"}
      </span>
      <input
        type="range"
        min={0}
        max={length || 0}
        step={0.05}
        value={length ? position : 0}
        disabled={!length}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)] disabled:cursor-default disabled:opacity-40"
      />
      <button
        type="button"
        onClick={() => {
          const el = ref.current;
          if (!el) return;
          el.muted = !el.muted;
          setMuted(el.muted);
        }}
        aria-label={muted ? "Unmute" : "Mute"}
        className="shrink-0 text-muted transition-colors hover:text-foreground"
      >
        <Speaker muted={muted} />
      </button>
      {kind === "video" && (
        <button
          type="button"
          onClick={() => {
            const box = wrap.current;
            if (!box) return;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void box.requestFullscreen?.();
          }}
          aria-label="Full screen"
          className="shrink-0 text-muted transition-colors hover:text-foreground"
        >
          <Expand />
        </button>
      )}
    </div>
  );

  if (kind === "video") {
    return (
      <div ref={wrap} className={`flex flex-col gap-2 rounded-xl border border-line bg-background p-2 ${className}`}>
        <video {...media} onClick={toggle} className="w-full cursor-pointer rounded-lg bg-black" />
        {controls}
        {error && <p className="text-xs text-bad">{error}</p>}
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-1 rounded-full border border-line bg-background py-1 pr-3 pl-1 ${className}`}>
      <audio {...media} />
      {controls}
      {error && <p className="px-2 text-xs text-bad">{error}</p>}
    </div>
  );
}
