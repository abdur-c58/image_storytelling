import "server-only";
import { and, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { readyAssetMap } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { assets, projects, segments, stories, storyMasters, tasks, type ProjectRow, type TaskRow } from "@/lib/db/schema";
import { NAME_CARD_TEMPLATE } from "@/lib/episode/constants";
import { buildImageItems, buildThumbnailItems, type ImageItem } from "@/lib/episode/prompt";
import type { Episode, StoryBible } from "@/lib/episode/schema";
import { env } from "@/lib/env";
import { createTask, logEvent, type TaskType } from "@/lib/queue";
import { assetKeys, INVALIDATES, requirements } from "./requirements";
import { commitStoryState, mastersGateOn } from "./story";

export const PROJECT_STATES = [
  "DRAFT",
  "VALIDATED",
  "WAITING_MASTERS",
  "GENERATING",
  "IMAGES_RECEIVED",
  "THUMBNAIL",
  "MIX",
  "RENDER",
  "REVIEW",
  "PUBLISH_REQUESTED",
  "PUBLISHED",
  "FAILED",
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

const MAX_EMPTY_COMPLETIONS = 3;

const isActive = (t: TaskRow) => t.status === "queued" || t.status === "leased";
const isLive = (t: TaskRow) => isActive(t) || t.status === "done";
const isThumbnailImageTask = (t: TaskRow) => t.type === "generate_images" && t.scope.startsWith("thumbnail");

function trigger(ep: Episode, id: string) {
  return ep.automation.bot_triggers.find((t) => t.trigger_id === id);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Output asset keys per stage; when any is missing (and nothing is running) the stage runs. */
function stageOutputs(ep: Episode): Record<string, string[]> {
  const req = requirements(ep);
  return {
    voice: req.spoken.map(assetKeys.voice),
    align: [assetKeys.timeline],
    sfx: req.cues.map((c) => assetKeys.sfx(c.cue_id)),
    cards: req.cards.map(assetKeys.card),
    thumbnail_compose: req.thumbnailVariants.map(assetKeys.thumbnail),
    mix: [assetKeys.mixAudio, assetKeys.mixReport],
    render: [assetKeys.video, assetKeys.preview],
  };
}

/** Outputs to retire when a stage is invalidated (prefix match for per-item slots). */
const INVALIDATION_OUTPUT_PREFIXES: Record<string, string[]> = {
  align: ["timeline/"],
  mix: ["mix/", "captions/"],
  render: ["video/"],
  thumbnail_compose: ["thumbnail/"],
  cards: ["card/"],
};

export async function invalidateStages(db: Db, projectId: string, stages: string[], reason: string): Promise<void> {
  const unique = [...new Set(stages)];
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const published = Boolean(project?.publishedAt);
  const taskTypes = unique.filter((s) => s !== "upload_youtube" || !published);
  if (taskTypes.length) {
    await db
      .update(tasks)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(tasks.projectId, projectId), inArray(tasks.type, taskTypes), inArray(tasks.status, ["done", "queued"])));
  }
  const prefixes = unique.flatMap((s) => INVALIDATION_OUTPUT_PREFIXES[s] ?? []);
  if (prefixes.length) {
    await db
      .update(assets)
      .set({ status: "superseded" })
      .where(
        and(
          eq(assets.projectId, projectId),
          eq(assets.status, "ready"),
          or(...prefixes.map((p) => like(assets.assetKey, `${p}%`))),
        ),
      );
  }
  await logEvent(db, projectId, null, "info", `Invalidated ${unique.join(", ")}: ${reason}`);
}

export async function invalidateDownstreamOf(db: Db, projectId: string, stage: string, reason: string): Promise<void> {
  const downstream = INVALIDATES[stage] ?? [];
  if (downstream.length) await invalidateStages(db, projectId, downstream, reason);
}

export function imageTaskPayload(projectId: string, ep: Episode, items: ImageItem[], purpose: "segments" | "thumbnail") {
  return {
    project_id: projectId,
    purpose,
    style_bible: {
      global_style_prompt: ep.style_bible.global_style_prompt,
      negative_prompt: ep.style_bible.negative_prompt,
      aspect_ratio: ep.style_bible.aspect_ratio,
      characters: ep.style_bible.characters,
    },
    image_provider: trigger(ep, "generate_images")?.image_provider ?? "google_flow",
    items,
  };
}

/**
 * Master keys an episode's images must still wait for (known to the story but not approved); null when the
 * story has no masters gate. Keys the story has no master for never block.
 */
export async function unapprovedMastersFor(db: Db, project: Pick<ProjectRow, "storyId">): Promise<Set<string> | null> {
  if (!project.storyId) return null;
  const [story] = await db.select().from(stories).where(eq(stories.id, project.storyId));
  if (!story || !mastersGateOn(story.bible as StoryBible)) return null;
  const rows = await db
    .select({ key: storyMasters.masterKey })
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, project.storyId), ne(storyMasters.status, "approved")));
  return new Set(rows.map((r) => r.key));
}

/**
 * Idempotent state machine step. Looks at what exists, queues whatever is now unblocked,
 * and recomputes the project's state. Safe to call after any event.
 */
export async function advance(db: Db, projectId: string): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId));
    if (!project || project.archived || project.state === "DRAFT") return;
    if (project.publishedAt) {
      if (project.state !== "PUBLISHED") {
        await tx.update(projects).set({ state: "PUBLISHED", stateDetail: "Published.", updatedAt: new Date() }).where(eq(projects.id, projectId));
      }
      if (project.storyId && !(project.outputs as { story_state_committed_at?: string }).story_state_committed_at) {
        await commitStoryState(tx, projectId);
      }
      return;
    }

    const ep = project.episode as Episode;
    const req = requirements(ep);
    const unapproved = await unapprovedMastersFor(tx, project);
    const waitsOn = (item: ImageItem) => (unapproved ? item.master_keys.filter((k) => unapproved.has(k)) : []);
    const waitingFor = new Set<string>();
    const all = await tx.select().from(tasks).where(eq(tasks.projectId, projectId));
    const ready = await readyAssetMap(tx, projectId);
    const has = (key: string) => ready.has(key);
    const ofType = (type: string) => all.filter((t) => t.type === type);
    const activeOf = (type: string, pred: (t: TaskRow) => boolean = () => true) => ofType(type).some((t) => isActive(t) && pred(t));
    const outputs = stageOutputs(ep);
    const missing = (stage: string) => outputs[stage].filter((k) => !has(k));
    const stageReady = (stage: string) => missing(stage).length === 0 && !activeOf(stage);
    const created: TaskRow[] = [];
    let failure: string | null = project.error;

    const dead = all.filter((t) => t.status === "dead");

    /** Queue a stage whose outputs are missing, with a guard against empty completions. */
    const runStage = async (type: TaskType, payload: Record<string, unknown>, opts: Partial<Parameters<typeof createTask>[1]> = {}) => {
      const doneCount = ofType(type).filter((t) => t.status === "done").length;
      if (doneCount >= MAX_EMPTY_COMPLETIONS) {
        failure ??= `Stage "${type}" finished ${doneCount} times without producing all outputs (${missing(type).slice(0, 5).join(", ")}).`;
        return;
      }
      created.push(await createTask(tx, { projectId, kind: "worker", type, payload, ...opts }));
    };

    if (!failure && dead.length === 0) {
      // ── Images (bot) ─────────────────────────────────────────────
      const segImageTasks = ofType("generate_images").filter((t) => !isThumbnailImageTask(t));
      const missingImages = req.images.filter((id) => !has(assetKeys.image(id)));
      if (missingImages.length && !segImageTasks.some(isActive)) {
        const imgTrigger = trigger(ep, "generate_images");
        const wanted = buildImageItems(ep).filter((i) => missingImages.includes(i.segment_id));
        for (const item of wanted) for (const k of waitsOn(item)) waitingFor.add(k);
        // All or nothing: images of one episode are generated against the same approved masters.
        const items = waitingFor.size ? [] : wanted;
        const isRetry = segImageTasks.length > 0;
        if (isRetry && items.length) {
          await tx
            .update(segments)
            .set({ imageAttempts: sql`${segments.imageAttempts} + 1` })
            .where(and(eq(segments.projectId, projectId), inArray(segments.segmentId, missingImages)));
          const rows = await tx
            .select()
            .from(segments)
            .where(and(eq(segments.projectId, projectId), inArray(segments.segmentId, missingImages)));
          const exhausted = rows.filter((r) => r.imageAttempts >= env.maxImageAttempts).map((r) => r.segmentId);
          if (exhausted.length) failure = `Images still missing after ${env.maxImageAttempts} attempts: ${exhausted.join(", ")}.`;
        }
        if (!failure) {
          const batches = chunk(items, imgTrigger?.batch_size ?? 8);
          for (const [i, batch] of batches.entries()) {
            created.push(
              await createTask(tx, {
                projectId,
                kind: "bot",
                type: "generate_images",
                scope: `${isRetry ? `retry${segImageTasks.length}` : "batch"}:${String(i + 1).padStart(2, "0")}`,
                payload: imageTaskPayload(projectId, ep, batch, "segments"),
                priority: isRetry ? 15 : 10,
                maxAttempts: imgTrigger?.retry.max_attempts ?? 3,
                backoffSec: imgTrigger?.retry.backoff_sec ?? 60,
                timeoutMinutes: imgTrigger?.timeout_minutes ?? 180,
              }),
            );
          }
        }
      }

      // ── Thumbnail base images (bot) ──────────────────────────────
      const thumbTasks = ofType("generate_images").filter(isThumbnailImageTask);
      const missingBases = req.thumbnailVariants.filter((v) => !has(assetKeys.thumbnailBase(v)));
      const thumbItems = buildThumbnailItems(ep).filter((i) => missingBases.includes(Number(i.asset_key.split("/")[1])));
      const thumbWaits = thumbItems.flatMap(waitsOn);
      for (const k of thumbWaits) waitingFor.add(k);
      if (!failure && missingBases.length && !thumbTasks.some(isActive) && !thumbWaits.length) {
        if (thumbTasks.filter((t) => t.status === "done").length >= env.maxImageAttempts) {
          failure = "Thumbnail base image still missing after repeated attempts.";
        } else {
          const thumbTrigger = trigger(ep, "generate_thumbnail_base");
          const items = thumbItems;
          created.push(
            await createTask(tx, {
              projectId,
              kind: "bot",
              type: "generate_images",
              scope: thumbTasks.length ? `thumbnail:retry${thumbTasks.length}` : "thumbnail",
              payload: imageTaskPayload(projectId, ep, items, "thumbnail"),
              priority: 9,
              maxAttempts: thumbTrigger?.retry.max_attempts ?? 3,
              backoffSec: thumbTrigger?.retry.backoff_sec ?? 60,
              timeoutMinutes: thumbTrigger?.timeout_minutes ?? 60,
            }),
          );
        }
      }

      const imagesReady = missingImages.length === 0 && !segImageTasks.some(isActive);
      const basesReady = missingBases.length === 0;

      // ── Worker stages ────────────────────────────────────────────
      if (missing("voice").length && !activeOf("voice")) {
        const ids = req.spoken.filter((id) => !has(assetKeys.voice(id)));
        await runStage("voice", { segment_ids: ids.length === req.spoken.length ? null : ids }, { priority: 5 });
      }
      const voiceReady = stageReady("voice");

      if (req.cues.length && missing("sfx").length && !activeOf("sfx")) {
        const ids = req.cues.filter((c) => !has(assetKeys.sfx(c.cue_id))).map((c) => c.cue_id);
        await runStage("sfx", { cue_ids: ids.length === req.cues.length ? null : ids }, { priority: 4 });
      }
      const sfxReady = stageReady("sfx");

      const cardsMissing = req.cards.filter((id) => !has(assetKeys.card(id)));
      const cardBgsReady = cardsMissing.every(
        (id) => !req.cardBackgrounds[id] || (has(assetKeys.image(req.cardBackgrounds[id])) && !segImageTasks.some(isActive)),
      );
      // A name card shows its character's approved master, so it waits for that approval (images wait for it anyway).
      const portraitPending = cardsMissing.some((id) => {
        const card = ep.segments.find((s) => s.id === id);
        const cid = card?.remotion?.template === NAME_CARD_TEMPLATE ? card.remotion.props.character_id : null;
        const outfit = cid ? ep.story?.characters.find((c) => c.id === cid)?.outfit_states[0]?.id : undefined;
        return !!outfit && !!unapproved?.has(`char/${cid}/${outfit}`);
      });
      if (cardsMissing.length && !activeOf("cards") && cardBgsReady && !portraitPending) {
        await runStage("cards", { segment_ids: cardsMissing.length === req.cards.length ? null : cardsMissing }, { priority: 3 });
      }
      const cardsReady = stageReady("cards");

      if (voiceReady && missing("align").length && !activeOf("align")) await runStage("align", {}, { priority: 6 });
      const alignReady = voiceReady && stageReady("align");

      if (basesReady && missing("thumbnail_compose").length && !activeOf("thumbnail_compose")) {
        await runStage("thumbnail_compose", {}, { priority: 2 });
      }
      const thumbReady = basesReady && stageReady("thumbnail_compose");

      if (alignReady && sfxReady && missing("mix").length && !activeOf("mix")) await runStage("mix", {}, { priority: 6, maxAttempts: 2 });
      const mixReady = alignReady && sfxReady && stageReady("mix");

      let waiting: string | null = null;
      if (mixReady && cardsReady && imagesReady && missing("render").length && !activeOf("render")) {
        if (ep.automation.approval_gates.before_render && !project.approvedRenderAt) waiting = "Waiting for render approval.";
        else await runStage("render", {}, { priority: 7, maxAttempts: 2, timeoutMinutes: 180 });
      }
      const renderReady = mixReady && cardsReady && imagesReady && stageReady("render");
      const outputsMeta = project.outputs as { description?: string; description_error?: string | null };

      const publishTasks = ofType("upload_youtube");
      if (renderReady && thumbReady && !project.publishedAt && !publishTasks.some(isLive)) {
        if (outputsMeta.description_error) {
          failure = outputsMeta.description_error;
        } else if (ep.automation.approval_gates.before_publish && !project.approvedPublishAt) {
          waiting = "Waiting for publish approval.";
        } else if (outputsMeta.description !== undefined) {
          const pubTrigger = trigger(ep, "publish_youtube");
          created.push(
            await createTask(tx, {
              projectId,
              kind: "bot",
              type: "upload_youtube",
              payload: { project_id: projectId },
              priority: 8,
              maxAttempts: pubTrigger?.retry.max_attempts ?? 2,
              backoffSec: pubTrigger?.retry.backoff_sec ?? 300,
              timeoutMinutes: pubTrigger?.timeout_minutes ?? 90,
            }),
          );
        }
      }

      // ── State ────────────────────────────────────────────────────
      const allTasks = [...all, ...created];
      const activeTypes = new Set(allTasks.filter(isActive).map((t) => t.type));
      let state: ProjectState;
      if (project.publishedAt) state = "PUBLISHED";
      else if (failure) state = "FAILED";
      else if (activeTypes.has("upload_youtube")) state = "PUBLISH_REQUESTED";
      else if (waiting) state = "REVIEW";
      else if (waitingFor.size && missingImages.length) state = "WAITING_MASTERS";
      else if (activeTypes.has("render")) state = "RENDER";
      else if (activeTypes.has("mix")) state = "MIX";
      else if (imagesReady && activeTypes.has("thumbnail_compose")) state = "THUMBNAIL";
      else if (imagesReady && !renderReady) state = "IMAGES_RECEIVED";
      else if (renderReady && !thumbReady) state = "THUMBNAIL";
      else if (renderReady && thumbReady) state = "REVIEW";
      else state = "GENERATING";

      const imagesDone = req.images.length - missingImages.length;
      const detail =
        failure ??
        waiting ??
        [
          waitingFor.size ? `waiting for ${waitingFor.size} story master(s) to be approved` : "",
          `images ${imagesDone}/${req.images.length}`,
          ...[...activeTypes].filter((t) => t !== "generate_images").map((t) => `${t} running`),
        ]
          .filter(Boolean)
          .join(" · ");
      await tx.update(projects).set({ state, stateDetail: detail, error: failure, updatedAt: new Date() }).where(eq(projects.id, projectId));
      if (failure && failure !== project.error) await logEvent(tx, projectId, null, "error", failure);
      return;
    }

    const deadSummary = dead.map((t) => `${t.type}(${t.scope}): ${t.error ?? "failed"}`).join("; ");
    const detail = failure ?? `Dead-lettered: ${deadSummary}`;
    await tx.update(projects).set({ state: "FAILED", stateDetail: detail, updatedAt: new Date() }).where(eq(projects.id, projectId));
  });
}
