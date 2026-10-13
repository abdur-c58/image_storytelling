const STATE_TONE: Record<string, string> = {
  DRAFT: "bg-muted",
  VALIDATED: "bg-muted",
  GENERATING: "bg-info",
  IMAGES_RECEIVED: "bg-info",
  THUMBNAIL: "bg-info",
  MIX: "bg-info",
  RENDER: "bg-info",
  REVIEW: "bg-warn",
  PUBLISH_REQUESTED: "bg-warn",
  PUBLISHED: "bg-ok",
  FAILED: "bg-bad",
};

const STATE_LABEL: Record<string, string> = {
  IMAGES_RECEIVED: "Images in",
  PUBLISH_REQUESTED: "Publishing",
};

export function StateBadge({ state }: { state: string }) {
  const label = STATE_LABEL[state] ?? state.charAt(0) + state.slice(1).toLowerCase();
  return (
    <span className="chip whitespace-nowrap text-foreground">
      <span className={`h-1.5 w-1.5 rounded-full ${STATE_TONE[state] ?? "bg-muted"}`} />
      {label}
    </span>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="mt-2 text-3xl font-bold tracking-tight md:text-4xl">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function ago(date: Date | string | null | undefined): string {
  if (!date) return "never";
  const sec = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function fmtSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "–";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
