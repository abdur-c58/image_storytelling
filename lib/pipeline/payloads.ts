import "server-only";
import { and, eq } from "drizzle-orm";
import { assetRef, readyAssetMap, signedDownloadLink, type AssetRef } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { assets, projects, segments, sfxCues, storyMasters, type TaskRow } from "@/lib/db/schema";
import { NAME_CARD_TEMPLATE, NARRATOR, YOUTUBE_CATEGORIES } from "@/lib/episode/constants";
import type { ImageItem } from "@/lib/episode/prompt";
import type { Episode } from "@/lib/episode/schema";
import { assetKeys, displayAssetKey, orderedSegments, requirements } from "./requirements";
import { episodeVoices } from "./voices";

/** Opens the bot console on this leased task (the console needs a bot-token sign-in). */
export function uploadPageUrl(baseUrl: string, taskId: string, leaseId: string): string {
  return `${baseUrl}/bot?task=${encodeURIComponent(taskId)}&lease=${encodeURIComponent(leaseId)}`;
}

async function refs(
  ready: Awaited<ReturnType<typeof readyAssetMap>>,
  keys: Record<string, string>,
  baseUrl: string,
): Promise<Record<string, AssetRef>> {
  const out: Record<string, AssetRef> = {};
  await Promise.all(
    Object.entries(keys).map(async ([name, key]) => {
      const asset = ready.get(key);
      if (asset) out[name] = await assetRef(asset, baseUrl);
    }),
  );
  return out;
}

/** Signed links to the approved master images, by master key. */
async function approvedMasterLinks(db: Db, storyId: string | null, baseUrl: string): Promise<Map<string, { url: string; label: string }>> {
  const out = new Map<string, { url: string; label: string }>();
  if (!storyId) return out;
  const rows = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "approved")));
  for (const r of rows) if (r.approvedAssetId) out.set(r.masterKey, { url: signedDownloadLink(baseUrl, r.approvedAssetId), label: r.label });
  return out;
}

function upload(baseUrl: string, task: TaskRow) {
  return {
    multipart_endpoint: `${baseUrl}/api/bot/tasks/${task.id}/assets`,
    presign_endpoint: `${baseUrl}/api/bot/tasks/${task.id}/upload-url`,
    browser_upload_page: uploadPageUrl(baseUrl, task.id, task.leaseId ?? ""),
  };
}

/** Everything the bot or worker needs for one task, with fresh signed URLs. */
export async function hydrateTask(db: Db, task: TaskRow, baseUrl: string): Promise<Record<string, unknown>> {
  const payload = task.payload as Record<string, unknown>;
  const base = {
    task_id: task.id,
    type: task.type,
    scope: task.scope,
    lease_id: task.leaseId,
    lease_expires_at: task.leaseExpiresAt,
    attempt: task.attempts,
    max_attempts: task.maxAttempts,
    project_id: task.projectId,
    story_id: task.storyId,
  };

  if (!task.projectId) {
    // Story tasks: generate_location_master.
    const done = new Set(
      (await db.select().from(assets).where(and(eq(assets.taskId, task.id), eq(assets.status, "ready")))).map((a) => a.assetKey),
    );
    const items = ((payload.items as { asset_key: string }[]) ?? []).map((item) => ({ ...item, already_uploaded: done.has(item.asset_key) }));
    return { ...base, payload: { ...payload, items }, total_items: items.length, upload: upload(baseUrl, task) };
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId));
  const ep = project.episode as Episode;
  const ready = await readyAssetMap(db, task.projectId);
  const req = requirements(ep);

  switch (task.type) {
    case "generate_images": {
      const masters = await approvedMasterLinks(db, project.storyId, baseUrl);
      const items = (payload.items as ImageItem[]).map((item) => {
        const refs = (item.master_keys ?? []).flatMap((k) => {
          const m = masters.get(k);
          return m ? [{ master_key: k, label: m.label, url: m.url }] : [];
        });
        return {
          ...item,
          reference_images: refs,
          reference_image_urls: [...refs.map((r) => r.url), ...(item.reference_image_urls ?? [])],
          already_uploaded: ready.has(item.asset_key) && !task.scope.startsWith("regen"),
        };
      });
      return {
        ...base,
        payload: { ...payload, items },
        total_items: items.length,
        upload: upload(baseUrl, task),
      };
    }
    case "upload_youtube": {
      const outputs = project.outputs as { description?: string };
      const video = ready.get(assetKeys.video);
      const thumb = ready.get(assetKeys.thumbnail(0));
      const yt = ep.youtube;
      return {
        ...base,
        payload: {
          project_id: task.projectId,
          video_download_url: video ? signedDownloadLink(baseUrl, video.id) : null,
          video_filename: `${ep.series.series_id}-ep${ep.series.episode_number}.mp4`,
          thumbnail_download_url: thumb ? signedDownloadLink(baseUrl, thumb.id) : null,
          thumbnail_variant_urls: req.thumbnailVariants
            .slice(1)
            .map((v) => ready.get(assetKeys.thumbnail(v)))
            .filter(Boolean)
            .map((a) => signedDownloadLink(baseUrl, a!.id)),
          channel_name: yt.channel_name,
          title: yt.title,
          description: outputs.description ?? yt.description,
          tags: yt.tags,
          category: yt.category,
          category_id: YOUTUBE_CATEGORIES[yt.category] ?? 24,
          language: yt.language,
          visibility: yt.visibility,
          scheduled_publish_at: yt.visibility === "scheduled" ? yt.scheduled_publish_at : null,
          playlist: yt.playlist,
          made_for_kids: yt.made_for_kids,
          contains_altered_or_synthetic_media: yt.contains_altered_or_synthetic_media,
          comments_enabled: yt.comments_enabled,
          pinned_comment: yt.pinned_comment,
          end_screen_note: yt.end_screen_note,
        },
      };
    }
    case "voice": {
      const rows = await db.select().from(segments).where(eq(segments.projectId, task.projectId));
      const voiceModes = Object.fromEntries(rows.map((r) => [r.segmentId, r.voiceMode]));
      const stored = ep.voices ?? {
        [NARRATOR]: {
          voice_id: ep.voice.voice_id,
          model: ep.voice.model,
          speed: ep.voice.speed,
          gain_db: 0,
          style_notes: ep.voice.style_notes,
          pronunciation_overrides: ep.voice.pronunciation_overrides,
        },
      };
      const voices = await episodeVoices(db, project.storyId, stored);
      return { ...base, payload: { ...payload, episode: { ...ep, voices }, voice_modes: voiceModes } };
    }
    case "align":
      return {
        ...base,
        payload: {
          episode: ep,
          voice: await refs(ready, Object.fromEntries(req.spoken.map((id) => [id, assetKeys.voice(id)])), baseUrl),
        },
      };
    case "sfx": {
      const rows = await db.select().from(sfxCues).where(eq(sfxCues.projectId, task.projectId));
      const selections = Object.fromEntries(
        rows.map((r) => [r.cueId, { selected_index: r.selectedIndex, candidates: r.candidates }]),
      );
      return { ...base, payload: { ...payload, episode: ep, selections } };
    }
    case "cards": {
      const bgKeys = Object.fromEntries(Object.entries(req.cardBackgrounds).map(([card, src]) => [card, assetKeys.image(src)]));
      const nameCards = ep.segments.filter((s) => s.remotion?.template === NAME_CARD_TEMPLATE && s.remotion.props.character_id);
      const masters = nameCards.length ? await approvedMasterLinks(db, project.storyId, baseUrl) : new Map<string, { url: string; label: string }>();
      const portraits: Record<string, { url: string }> = {};
      for (const s of nameCards) {
        const cid = s.remotion!.props.character_id!;
        const outfit = ep.story?.characters.find((c) => c.id === cid)?.outfit_states[0]?.id;
        const key = (outfit && masters.has(`char/${cid}/${outfit}`) ? `char/${cid}/${outfit}` : null) ?? [...masters.keys()].find((k) => k.startsWith(`char/${cid}/`));
        if (key) portraits[s.id] = { url: masters.get(key)!.url };
      }
      return { ...base, payload: { ...payload, episode: ep, backgrounds: await refs(ready, bgKeys, baseUrl), portraits } };
    }
    case "thumbnail_compose": {
      const keys = Object.fromEntries(req.thumbnailVariants.map((v) => [String(v), assetKeys.thumbnailBase(v)]));
      return { ...base, payload: { episode: ep, bases: await refs(ready, keys, baseUrl) } };
    }
    case "mix": {
      const voiceKeys = Object.fromEntries(req.spoken.map((id) => [id, assetKeys.voice(id)]));
      const sfxKeys = Object.fromEntries(req.cues.map((c) => [c.cue_id, assetKeys.sfx(c.cue_id)]));
      return {
        ...base,
        payload: {
          episode: ep,
          timeline: (await refs(ready, { t: assetKeys.timeline }, baseUrl)).t ?? null,
          voice: await refs(ready, voiceKeys, baseUrl),
          sfx: await refs(ready, sfxKeys, baseUrl),
        },
      };
    }
    case "render": {
      const displayKeys: Record<string, string> = {};
      for (const seg of orderedSegments(ep)) {
        const key = displayAssetKey(ep, seg);
        if (key) displayKeys[seg.id] = key;
      }
      const singles = await refs(
        ready,
        { timeline: assetKeys.timeline, mix_audio: assetKeys.mixAudio, captions: assetKeys.captions },
        baseUrl,
      );
      return {
        ...base,
        payload: {
          episode: ep,
          timeline: singles.timeline ?? null,
          mix_audio: singles.mix_audio ?? null,
          captions: singles.captions ?? null,
          display: await refs(ready, displayKeys, baseUrl),
        },
      };
    }
    default:
      return { ...base, payload };
  }
}

export async function selectedSfx(db: Db, projectId: string, cueId: string) {
  const [row] = await db.select().from(sfxCues).where(and(eq(sfxCues.projectId, projectId), eq(sfxCues.cueId, cueId)));
  return row ?? null;
}
