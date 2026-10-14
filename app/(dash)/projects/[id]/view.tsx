import { asc, desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { presignAssetGet, readyAssetMap } from "@/lib/assets";
import { getDb } from "@/lib/db";
import { projects, segments, sfxCues, taskEvents, tasks } from "@/lib/db/schema";
import type { CropKeyframe } from "@/lib/crop/plan";
import type { SentenceTiming } from "@/lib/crop/sentences";
import type { StoryStateSnapshot } from "@/lib/episode/continuity";
import type { PromptPart } from "@/lib/episode/prompt";
import { isResolvedV2 } from "@/lib/episode/resolve";
import type { LineTiming } from "@/lib/crop/timeline";
import { NARRATOR } from "@/lib/episode/constants";
import type { Episode, Line, Segment } from "@/lib/episode/schema";
import { episodePovReport as povReport, type PovStatus } from "@/lib/episode/structure";
import type { ValidationIssue } from "@/lib/episode/validate";
import { pageBaseUrl } from "@/lib/http";
import type { CropSummary } from "@/lib/pipeline/crop";
import { assetKeys, displayAssetKey, orderedSegments, requirements } from "@/lib/pipeline/requirements";
import { ago, fmtSec, StateBadge } from "../../ui";
import { ActionButton, AutoRefresh, CopyButton, CropToggle, DeleteProjectButton } from "./client";
import { CropStrip, PromptInspector } from "./inspect";

const ACTIVE_STATES = new Set([
  "VALIDATED",
  "GENERATING",
  "WAITING_MASTERS",
  "IMAGES_RECEIVED",
  "THUMBNAIL",
  "MIX",
  "RENDER",
  "PUBLISH_REQUESTED",
]);
const STAGES = ["generate_images", "voice", "sfx", "cards", "align", "thumbnail_compose", "mix", "render", "upload_youtube"];

interface SfxCandidate {
  provider: string;
  title?: string;
  author?: string;
  license: string;
  source_url?: string;
  duration_sec?: number;
  score?: number;
}

/** One episode version: pipeline stages, outputs, segments and log. Rendered inside the episode page. */
export async function ProjectView({
  id,
  breadcrumb,
  basename,
  onlyVersion,
}: {
  id: string;
  breadcrumb: React.ReactNode;
  basename: string | null;
  onlyVersion: boolean;
}) {
  const db = await getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) notFound();
  const ep = project.episode as Episode;
  const base = await pageBaseUrl();
  const [segRows, cueRows, taskRows, events, ready] = await Promise.all([
    db.select().from(segments).where(eq(segments.projectId, id)).orderBy(asc(segments.order)),
    db.select().from(sfxCues).where(eq(sfxCues.projectId, id)),
    db.select().from(tasks).where(eq(tasks.projectId, id)).orderBy(desc(tasks.createdAt)),
    db.select().from(taskEvents).where(eq(taskEvents.projectId, id)).orderBy(desc(taskEvents.createdAt)).limit(80),
    readyAssetMap(db, id),
  ]);
  const url = async (key: string | null, filename?: string) => {
    const asset = key ? ready.get(key) : undefined;
    return asset ? presignAssetGet(asset, base, filename) : null;
  };
  const req = requirements(ep);
  const outputs = project.outputs as {
    description?: string;
    description_error?: string | null;
    chapters_problem?: string | null;
    duration_sec?: number;
    mix_report?: Record<string, unknown> | null;
    crop?: CropSummary;
    story_state_end?: StoryStateSnapshot;
    story_state_committed_at?: string;
  };
  const v2 = isResolvedV2(ep);
  const cropSegments = outputs.crop?.segments ?? {};
  const stem = basename ?? `${ep.series.series_id}-ep${ep.series.episode_number}`;
  const [videoUrl, previewUrl, thumbUrl, captionsUrl, reportUrl] = await Promise.all([
    url(assetKeys.video, `${stem}.mp4`),
    url(assetKeys.preview),
    url(assetKeys.thumbnail(0), `${stem}-thumbnail.jpg`),
    url(assetKeys.captions, `${stem}.srt`),
    url(assetKeys.mixReport, `${stem}-mix_report.json`),
  ]);
  const altThumbs = await Promise.all(req.thumbnailVariants.slice(1).map((v) => url(assetKeys.thumbnail(v))));
  const segPreview = new Map(
    await Promise.all(orderedSegments(ep).map(async (s) => [s.id, await url(displayAssetKey(ep, s))] as const)),
  );
  const voiceUrls = new Map(await Promise.all(req.spoken.map(async (sid) => [sid, await url(assetKeys.voice(sid))] as const)));
  const segById = new Map(ep.segments.map((s) => [s.id, s]));
  const speakerNames: Record<string, string> = { [NARRATOR]: "Narrator" };
  if (v2) for (const c of ep.story.characters) speakerNames[c.id] = c.name;
  const pov = v2 ? povReport(ep) : null;
  const povStatus = new Map((pov?.segments ?? []).filter((s) => s.status !== "ineligible").map((s) => [s.segment_id, s]));
  const warnings = project.warnings as ValidationIssue[];
  const activeTasks = taskRows.filter((t) => t.status === "queued" || t.status === "leased");
  const deadTasks = taskRows.filter((t) => t.status === "dead");
  const waitingRender = project.state === "REVIEW" && project.stateDetail === "Waiting for render approval.";
  const waitingPublish = project.state === "REVIEW" && project.stateDetail === "Waiting for publish approval.";

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh enabled={ACTIVE_STATES.has(project.state)} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {breadcrumb}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{project.title}</h1>
            <StateBadge state={project.state} />
            {project.archived && <span className="chip text-muted">Stopped</span>}
          </div>
          <p className={`mt-2 font-light ${project.state === "FAILED" ? "text-bad" : "text-muted"}`}>{project.stateDetail}</p>
          <p className="mt-1 text-sm font-light text-muted">
            {ep.segments.length} segments · created {ago(project.createdAt)}
          </p>
          {project.youtubeUrl && (
            <a href={project.youtubeUrl} target="_blank" rel="noreferrer" className="link mt-1 inline-block text-sm text-ok">
              {project.youtubeUrl}
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {project.state === "DRAFT" && <ActionButton projectId={id} action={{ kind: "start" }} primary label="Start" />}
          {(project.state === "FAILED" || deadTasks.length > 0) && (
            <ActionButton projectId={id} action={{ kind: "retry" }} primary label="Retry failed" />
          )}
          {waitingRender && <ActionButton projectId={id} action={{ kind: "approve", gate: "render" }} primary label="Approve render" />}
          {waitingPublish && (
            <ActionButton projectId={id} action={{ kind: "approve", gate: "publish" }} primary label="Approve publish" confirm="Send this video to the bot for upload?" />
          )}
          {!project.publishedAt && project.state !== "DRAFT" && (
            <>
              <ActionButton projectId={id} action={{ kind: "rerender" }} label="Re-mix & re-render" />
              <ActionButton projectId={id} action={{ kind: "regen_thumbnail" }} label="New thumbnail image" />
              {outputs.crop && (
                <ActionButton
                  projectId={id}
                  action={{ kind: "reroll_crops" }}
                  label="Re-roll all crops"
                  confirm="Draw new crops for every segment? Only the render re-runs."
                />
              )}
            </>
          )}
          <DeleteProjectButton
            projectId={id}
            title={project.title}
            published={!!project.publishedAt}
            active={activeTasks.length > 0}
            only={onlyVersion}
          />
        </div>
      </div>

      <section className="flex flex-wrap gap-2">
        {STAGES.map((stage) => {
          const of = taskRows.filter((t) => t.type === stage && t.status !== "superseded" && t.status !== "cancelled");
          const status = of.some((t) => t.status === "dead")
            ? "dead"
            : of.some((t) => t.status === "leased")
              ? "running"
              : of.some((t) => t.status === "queued")
                ? "queued"
                : of.some((t) => t.status === "done")
                  ? "done"
                  : "waiting";
          const dot = {
            dead: "bg-bad",
            running: "bg-info animate-pulse",
            queued: "bg-muted",
            done: "bg-ok",
            waiting: "border border-line-hover",
          }[status];
          return (
            <span key={stage} className={`chip ${status === "waiting" ? "" : "text-foreground"}`} title={status}>
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              {stage.replace(/_/g, " ")}
            </span>
          );
        })}
      </section>

      {(outputs.description_error || outputs.chapters_problem) && (
        <section className="card text-sm text-warn">
          {outputs.description_error && <p>{outputs.description_error}</p>}
          {outputs.chapters_problem && <p>Chapters left out: {outputs.chapters_problem}</p>}
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card flex flex-col gap-2">
          <h2 className="eyebrow">Video</h2>
          {previewUrl || videoUrl ? (
            <video src={previewUrl ?? videoUrl ?? undefined} controls preload="metadata" className="w-full rounded-xl border border-line" />
          ) : (
            <p className="text-sm text-muted">Not rendered yet.</p>
          )}
          <div className="flex flex-wrap gap-2 text-sm">
            {videoUrl && <a className="btn" href={videoUrl}>Download MP4 {outputs.duration_sec ? `(${fmtSec(outputs.duration_sec)})` : ""}</a>}
            {captionsUrl && <a className="btn" href={captionsUrl}>Captions (.srt)</a>}
            {reportUrl && <a className="btn" href={reportUrl}>mix_report.json</a>}
          </div>
          {outputs.mix_report && <MixSummary report={outputs.mix_report} />}
        </div>
        <div className="card flex flex-col gap-2">
          <h2 className="eyebrow">Thumbnail</h2>
          {thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbUrl} alt="Thumbnail" className="w-full rounded-xl border border-line" />
          ) : (
            <p className="text-sm text-muted">Not composed yet.</p>
          )}
          {thumbUrl && (
            <div className="flex flex-wrap gap-2 text-sm">
              <a className="btn" href={thumbUrl}>
                Download thumbnail
              </a>
            </div>
          )}
          {altThumbs.some(Boolean) && (
            <div className="flex gap-2">
              {altThumbs.map((u, i) =>
                // eslint-disable-next-line @next/next/no-img-element
                u ? <img key={i} src={u} alt={`Variant ${i + 1}`} className="w-1/3 rounded-lg border border-line" /> : null,
              )}
            </div>
          )}
        </div>
      </section>

      {project.storyId && outputs.story_state_end && (
        <section className="card flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="eyebrow">Story state after this episode</h2>
            <div className="flex flex-wrap items-center gap-2">
              {outputs.story_state_committed_at ? (
                <span className="chip text-ok">committed {ago(outputs.story_state_committed_at)}</span>
              ) : (
                <ActionButton
                  projectId={id}
                  action={{ kind: "commit_story_state" }}
                  label="Commit to story"
                  small
                  confirm="Record this episode's end state on the story now? (Publishing does this automatically.)"
                />
              )}
              <CopyButton text={JSON.stringify(outputs.story_state_end, null, 2)} label="Copy JSON" />
            </div>
          </div>
          <StateSummary snapshot={outputs.story_state_end} />
        </section>
      )}

      <section className="card flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="eyebrow">YouTube description</h2>
          {outputs.description && (
            <div className="flex gap-2">
              <CopyButton text={outputs.description} label="Copy" />
              <a className="btn px-3 py-0.5 text-xs" href={`/api/projects/${id}/files?kind=description`}>
                Download
              </a>
            </div>
          )}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted">
          {outputs.description ?? `${ep.youtube.description}\n\n(Chapters, series links and credits are filled in after render.)`}
        </pre>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="eyebrow">Segments</h2>
          {pov && pov.ratio !== null && (
            <span className={`text-xs ${pov.enforced && pov.ratio < pov.min ? "text-warn" : "text-muted"}`}>
              Viewer ({pov.pov_character_id}) on screen in {pov.on_screen}/{pov.eligible} present-day pictures ({Math.round(pov.ratio * 100)}%)
            </span>
          )}
        </div>
        <table className="w-full text-xs">
          <thead className="text-left text-muted">
            <tr>
              <th className="w-48 py-1">Picture</th>
              <th>Segment</th>
              <th>Lines</th>
              <th>Timing</th>
              {v2 && <th>Crops</th>}
              <th>QA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {segRows.map((row) => {
              const seg = segById.get(row.segmentId);
              const qa = row.qa as { wer?: number | null; flagged?: boolean; transcript?: string | null; tag_leak?: string[] };
              const cropInfo = cropSegments[row.segmentId] as
                | { sentences: SentenceTiming[]; crop_plan: CropKeyframe[]; enabled: boolean | null }
                | undefined;
              const parts = row.promptParts as PromptPart[];
              const masterKeys = row.masterKeys as string[];
              const preview = segPreview.get(row.segmentId);
              const voice = voiceUrls.get(row.segmentId);
              const hasImage = req.images.includes(row.segmentId);
              return (
                <tr key={row.segmentId} className="border-t border-line align-top">
                  <td className="py-2 pr-2">
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={preview} alt={row.segmentId} className="w-44 rounded-lg border border-line" />
                    ) : (
                      <div className="dot-grid flex h-24 w-44 items-center justify-center rounded-lg border border-line text-muted">pending</div>
                    )}
                  </td>
                  <td className="pr-2">
                    <div className="font-mono">{row.segmentId}</div>
                    <div className="text-muted">{row.type}</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {seg?.role && seg.role !== "main" && <span className="chip text-info">{seg.role.replace(/_/g, " ")}</span>}
                      {povStatus.get(row.segmentId) && (
                        <span
                          className={`chip ${povStatus.get(row.segmentId)!.status === "missing" ? "text-warn" : "text-muted"}`}
                          title={povStatus.get(row.segmentId)!.reason ?? `${pov!.pov_character_id} ${POV_CHIP[povStatus.get(row.segmentId)!.status]}`}
                        >
                          POV {POV_CHIP[povStatus.get(row.segmentId)!.status]}
                        </span>
                      )}
                    </div>
                    {row.imageAttempts > 0 && <div className="text-warn">image retries: {row.imageAttempts}</div>}
                  </td>
                  <td className="max-w-md pr-2">
                    {seg && isDialogue(seg) ? (
                      <LineList lines={seg.lines!} timings={row.lineTimings as LineTiming[]} voiceUrl={voice ?? null} names={speakerNames} />
                    ) : (
                      <p>{row.narration || <span className="text-muted">(silent)</span>}</p>
                    )}
                    {row.finalPrompt && (
                      <details className="mt-1 text-muted">
                        <summary className="cursor-pointer">{parts.length ? "prompt inspector" : "final prompt"}</summary>
                        {parts.length ? (
                          <PromptInspector parts={parts} masterKeys={masterKeys} negative={row.negativePrompt} />
                        ) : (
                          <p className="mt-1 whitespace-pre-wrap">{row.finalPrompt}</p>
                        )}
                      </details>
                    )}
                    {row.voiceMode !== "normal" && <p className="mt-1 text-warn">voice: {row.voiceMode.replace(/_/g, " ")}</p>}
                    {voice && <audio src={voice} controls preload="none" className="mt-1 h-7 w-full" />}
                  </td>
                  <td className="pr-2 font-mono text-muted">
                    {fmtSec(row.startSec)}–{fmtSec(row.endSec)}
                    <div>voice {row.audioDurationSec ? `${row.audioDurationSec.toFixed(1)}s` : "–"}</div>
                  </td>
                  {v2 && (
                    <td className="pr-2">
                      {cropInfo && row.startSec !== null && row.endSec !== null && hasPicture(row.type) ? (
                        <div className="flex flex-col gap-1">
                          <CropStrip start={row.startSec} end={row.endSec} sentences={cropInfo.sentences} plan={cropInfo.crop_plan} />
                          {!project.publishedAt && (
                            <div className="flex flex-wrap items-center gap-1">
                              <CropToggle projectId={id} segmentId={row.segmentId} enabled={row.cropEnabled} />
                              <ActionButton
                                projectId={id}
                                action={{ kind: "reroll_crops", segmentId: row.segmentId }}
                                label="Re-roll"
                                small
                              />
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted">{hasPicture(row.type) ? "after alignment" : "–"}</span>
                      )}
                    </td>
                  )}
                  <td className="pr-2">
                    {qa.wer !== undefined && qa.wer !== null && (
                      <span className={qa.flagged ? "text-bad" : "text-ok"} title={qa.transcript ?? ""}>
                        WER {qa.wer.toFixed(2)}
                      </span>
                    )}
                    {qa.tag_leak && qa.tag_leak.length > 0 && (
                      <p className="text-bad" title="Whisper heard these tag words; Fish read a tag aloud.">
                        tag spoken: {qa.tag_leak.join(", ")}
                      </p>
                    )}
                  </td>
                  <td className="flex flex-col gap-1 py-2">
                    {!project.publishedAt && hasImage && (
                      <ActionButton projectId={id} action={{ kind: "regen_image", segmentId: row.segmentId }} label="New image" small />
                    )}
                    {!project.publishedAt && req.spoken.includes(row.segmentId) && (
                      <ActionButton projectId={id} action={{ kind: "regen_voice", segmentId: row.segmentId }} label="Redo voice" small />
                    )}
                    {seg?.image?.reuse_from_segment_id && (
                      <span className="text-muted">reuses {seg.image.reuse_from_segment_id}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {cueRows.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="eyebrow mb-3">Sound effects</h2>
          <table className="w-full text-xs">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1">Cue</th>
                <th>Candidates (licence)</th>
              </tr>
            </thead>
            <tbody>
              {cueRows.map((cue) => {
                const candidates = cue.candidates as SfxCandidate[];
                return (
                  <tr key={cue.cueId} className="border-t border-line align-top">
                    <td className="py-2 pr-3 font-mono">{cue.cueId}</td>
                    <td className="flex flex-col gap-1 py-2">
                      {candidates.length === 0 && <span className="text-warn">No licensed clip found; silent placeholder used.</span>}
                      {candidates.map((c, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className={i === cue.selectedIndex ? "text-foreground" : "text-muted"}>{i === cue.selectedIndex ? "●" : "○"}</span>
                          <span>
                            {c.title ?? "Untitled"} {c.author ? `by ${c.author}` : ""} · {c.provider} · {c.license}
                            {c.duration_sec ? ` · ${c.duration_sec.toFixed(1)}s` : ""}
                          </span>
                          {c.source_url && (
                            <a href={c.source_url} target="_blank" rel="noreferrer" className="link">
                              source
                            </a>
                          )}
                          {i !== cue.selectedIndex && !project.publishedAt && (
                            <ActionButton projectId={id} action={{ kind: "swap_sfx", cueId: cue.cueId, index: i }} label="Use" small />
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-x-auto">
          <h2 className="eyebrow mb-3">
            Tasks <span className="text-sm font-normal text-muted">({activeTasks.length} active)</span>
          </h2>
          <table className="w-full text-xs">
            <tbody>
              {taskRows.slice(0, 60).map((t) => {
                const progress = t.progress as { completed_items?: number; total_items?: number; message?: string };
                return (
                  <tr key={t.id} className="border-t border-line align-top">
                    <td className="py-1 pr-2 font-mono">{t.type}</td>
                    <td className="pr-2 text-muted">{t.scope}</td>
                    <td className="pr-2">{t.status}</td>
                    <td className="pr-2 text-muted">
                      {t.attempts}/{t.maxAttempts}
                    </td>
                    <td className="pr-2 text-muted">
                      {progress.total_items ? `${progress.completed_items ?? 0}/${progress.total_items}` : ""} {progress.message ?? ""}
                    </td>
                    <td className="max-w-xs text-bad">{t.error}</td>
                    <td className="pl-2">
                      {t.status === "dead" && <ActionButton projectId={id} action={{ kind: "retry", taskId: t.id }} label="Retry" small />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card flex flex-col gap-1 overflow-auto text-xs" style={{ maxHeight: 480 }}>
          <h2 className="eyebrow mb-2">Log</h2>
          {warnings.map((w, i) => (
            <p key={`w${i}`} className="text-warn">
              validation: {w.message}
            </p>
          ))}
          {events.map((e) => (
            <p key={e.id} className={e.level === "error" ? "text-bad" : e.level === "warning" ? "text-warn" : "text-muted"}>
              <span className="font-mono">{new Date(e.createdAt).toLocaleTimeString()}</span> {e.message}
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

const hasPicture = (type: string) => type !== "title_card" && type !== "infographic";

const POV_CHIP: Record<PovStatus, string> = { on_screen: "on screen", missing: "missing", exception: "exception", ineligible: "" };

/** Worth showing line by line: more than one line, or anyone but the narrator speaking. */
const isDialogue = (seg: Segment) => !!seg.lines && (seg.lines.length > 1 || seg.lines.some((l) => l.speaker !== NARRATOR));

function LineList({ lines, timings, voiceUrl, names }: { lines: Line[]; timings: LineTiming[]; voiceUrl: string | null; names: Record<string, string> }) {
  const byId = new Map(timings.map((t) => [t.line_id, t]));
  return (
    <ol className="flex flex-col gap-1.5">
      {lines.map((line) => {
        const t = byId.get(line.id);
        return (
          <li key={line.id} className="flex flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-1">
              <SpeakerChip speaker={line.speaker} name={names[line.speaker] ?? line.speaker} />
              {line.voice_effect !== "none" && (
                <span className="chip text-info" title="voice effect">
                  {line.voice_effect}
                </span>
              )}
              {line.speaker !== NARRATOR && !line.on_screen && <span className="chip text-muted">off screen</span>}
              {line.source === "written" && <span className="chip text-muted">written</span>}
              {t && <span className="font-mono text-muted">{(t.end - t.start).toFixed(1)}s</span>}
            </div>
            <p>{line.text}</p>
            {voiceUrl && t && <audio src={`${voiceUrl}#t=${t.start.toFixed(2)},${t.end.toFixed(2)}`} controls preload="none" className="h-7 w-full" />}
          </li>
        );
      })}
    </ol>
  );
}

function SpeakerChip({ speaker, name }: { speaker: string; name: string }) {
  let hash = 0;
  for (const ch of speaker) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = speaker === NARRATOR ? undefined : `hsl(${hash % 360} 65% 62%)`;
  return (
    <span className="chip font-medium" style={color ? { color, borderColor: color } : undefined}>
      {name}
    </span>
  );
}

function StateSummary({ snapshot }: { snapshot: StoryStateSnapshot }) {
  const rows: [string, string][] = [
    ...Object.entries(snapshot.locations).map(([k, v]): [string, string] => [`location ${k}`, v]),
    ...Object.entries(snapshot.world).map(([k, v]): [string, string] => [k, String(v)]),
    ...Object.entries(snapshot.outfits).map(([k, v]): [string, string] => [`outfit ${k}`, v]),
    ...Object.entries(snapshot.character_status ?? {}).map(([k, v]): [string, string] => [`status ${k}`, v.status]),
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-light text-muted">{k}</dt>
          <dd className="font-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function MixSummary({ report }: { report: Record<string, unknown> }) {
  const num = (k: string) => (typeof report[k] === "number" ? (report[k] as number).toFixed(1) : "–");
  return (
    <p className="text-xs text-muted">
      Loudness {num("integrated_lufs")} LUFS · true peak {num("true_peak_dbtp")} dBTP · LRA {num("lra")} LU
      {report.passed === false ? <span className="text-bad"> · outside target</span> : null}
    </p>
  );
}
