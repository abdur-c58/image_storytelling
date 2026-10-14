import type { CropKeyframe } from "@/lib/crop/plan";
import type { SentenceTiming } from "@/lib/crop/sentences";
import type { PromptPart } from "@/lib/episode/prompt";

const PART_TONE: Record<string, string> = {
  style: "border-line text-muted",
  anchor: "border-info/50 text-info",
  state: "border-info/50 text-info",
  angle: "border-info/50 text-info",
  world: "border-warn/50 text-warn",
  character: "border-ok/50 text-ok",
  props: "border-ok/50 text-ok",
  cameo: "border-ok/50 text-ok",
  scene: "border-line-hover text-foreground",
};

/** The final prompt split into the pieces it was assembled from, with the masters sent as references. */
export function PromptInspector({ parts, masterKeys, negative }: { parts: PromptPart[]; masterKeys: string[]; negative?: string | null }) {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {parts.map((p, i) => (
        <div key={i} className={`rounded-lg border px-2 py-1 ${PART_TONE[p.kind] ?? "border-line text-muted"}`}>
          <span className="font-mono text-[10px] uppercase tracking-wide opacity-70">
            {p.kind}
            {p.label ? ` · ${p.label}` : ""}
          </span>
          <p className="whitespace-pre-wrap text-foreground/90">{p.text}</p>
        </div>
      ))}
      {negative && (
        <div className="rounded-lg border border-bad/40 px-2 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-bad opacity-70">negative</span>
          <p className="whitespace-pre-wrap">{negative}</p>
        </div>
      )}
      {masterKeys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <span className="text-muted">references:</span>
          {masterKeys.map((k) => (
            <span key={k} className="chip font-mono text-[10px]">
              {k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Segment timeline: sentence blocks along the voice, shaded where the picture is cropped (amount in %),
 * with the move windows hatched.
 */
export function CropStrip({
  start,
  end,
  sentences,
  plan,
}: {
  start: number;
  end: number;
  sentences: SentenceTiming[];
  plan: CropKeyframe[];
}) {
  const span = Math.max(0.001, end - start);
  const pct = (t: number) => `${(Math.min(Math.max(t - start, 0), span) / span) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(b, end) - Math.max(a, start)) / span) * 100}%`;
  const holds: { from: number; to: number; amount: number; label: string | null }[] = [];
  for (let i = 0; i < plan.length; i++) {
    const k = plan[i];
    if (k.kind !== "crop") continue;
    const next = plan[i + 1];
    holds.push({ from: k.at_sec, to: next ? next.at_sec + next.duration_sec : end, amount: k.amount, label: k.focal_label });
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="relative h-6 w-56 overflow-hidden rounded-md border border-line bg-background">
        {sentences.map((s) => (
          <div
            key={s.index}
            title={`${s.index + 1}: ${s.text}`}
            className="absolute top-0 h-2 rounded-sm bg-muted/40"
            style={{ left: pct(s.start_sec), width: width(s.start_sec, s.end_sec) }}
          />
        ))}
        {holds.map((h, i) => (
          <div
            key={i}
            title={`${(h.amount * 100).toFixed(1)}% crop${h.label ? ` on ${h.label}` : ""}`}
            className="absolute bottom-0 flex h-4 items-center justify-center rounded-sm bg-info/30 text-[9px] text-foreground"
            style={{ left: pct(h.from), width: width(h.from, h.to) }}
          >
            {Math.round(h.amount * 100)}%
          </div>
        ))}
        {plan.map((k, i) => (
          <div
            key={`m${i}`}
            className="absolute bottom-0 h-4 bg-info/70"
            style={{ left: pct(k.at_sec), width: `max(1px, ${width(k.at_sec, k.at_sec + k.duration_sec)})` }}
          />
        ))}
      </div>
      <span className="text-muted">
        {sentences.length} sentence{sentences.length === 1 ? "" : "s"} · {holds.length ? `${holds.length} crop${holds.length === 1 ? "" : "s"}` : "full frame"}
      </span>
    </div>
  );
}
