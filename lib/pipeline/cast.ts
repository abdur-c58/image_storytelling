import "server-only";
import { and, eq } from "drizzle-orm";
import { createAsset } from "@/lib/assets";
import type { Db } from "@/lib/db";
import { assets, channelCharacters, storyMasters, type ChannelCharacterRow } from "@/lib/db/schema";
import type { CastRegistry, ChannelCharacterEntry } from "@/lib/episode/cast";
import type { StoryBible, StoryCharacter } from "@/lib/episode/schema";
import { logEvent } from "@/lib/queue";
import { getStorage } from "@/lib/storage";

type ReferenceAsset = StoryBible["style_bible"]["reference_assets"][number];
type ChannelMasters = Record<string, { story_id: string; asset_id: string }>;

function toEntry(r: ChannelCharacterRow): ChannelCharacterEntry {
  return {
    id: r.id,
    definition: r.definition as StoryCharacter,
    reference_assets: r.referenceAssets as ReferenceAsset[],
    origin_story_id: r.originStoryId,
  };
}

export async function loadCastRegistry(db: Db): Promise<CastRegistry> {
  const rows = await db.select().from(channelCharacters);
  return new Map(rows.map((r) => [r.id, toEntry(r)]));
}

export async function listChannelCharacters(db: Db): Promise<ChannelCharacterRow[]> {
  return db.select().from(channelCharacters).orderBy(channelCharacters.name);
}

/**
 * Put the bible's channel characters into the registry. Only the story that first defined a character may
 * change its definition; outfits other stories add stay in those stories.
 */
export async function registerChannelCast(db: Db, bible: StoryBible): Promise<string[]> {
  const registered: string[] = [];
  for (const c of bible.characters) {
    if (c.scope !== "channel") continue;
    const refs = bible.style_bible.reference_assets.filter((a) => c.reference_image_ids.includes(a.id));
    const [row] = await db.select().from(channelCharacters).where(eq(channelCharacters.id, c.id));
    if (!row) {
      await db.insert(channelCharacters).values({
        id: c.id,
        name: c.name,
        definition: c,
        referenceAssets: refs,
        originStoryId: bible.story_id,
      });
      registered.push(c.id);
    } else if (row.originStoryId === bible.story_id) {
      await db
        .update(channelCharacters)
        .set({ name: c.name, definition: c, referenceAssets: refs, updatedAt: new Date() })
        .where(eq(channelCharacters.id, c.id));
    }
  }
  if (registered.length) {
    await logEvent(db, { storyId: bible.story_id }, null, "info", `Added to the channel cast: ${registered.join(", ")}.`);
  }
  return registered;
}

const characterOf = (masterKey: string) => (masterKey.startsWith("char/") ? masterKey.split("/")[1] : null);

/** Remember an approved character sheet so later stories with the same character start from it. */
export async function recordChannelMaster(db: Db, storyId: string, masterKey: string, assetId: string): Promise<void> {
  const id = characterOf(masterKey);
  if (!id) return;
  const [row] = await db.select().from(channelCharacters).where(eq(channelCharacters.id, id));
  if (!row) return;
  const masters = { ...(row.masters as ChannelMasters), [masterKey]: { story_id: storyId, asset_id: assetId } };
  await db.update(channelCharacters).set({ masters, updatedAt: new Date() }).where(eq(channelCharacters.id, id));
}

/**
 * Copy approved channel character sheets into a story whose same master is still missing, and approve them
 * there. Copies (not links) so deleting the first story does not break later ones.
 */
export async function reuseChannelMasters(db: Db, storyId: string): Promise<string[]> {
  const missing = await db
    .select()
    .from(storyMasters)
    .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.status, "missing"), eq(storyMasters.kind, "character")));
  const reused: string[] = [];
  for (const m of missing) {
    const id = characterOf(m.masterKey);
    if (!id) continue;
    const [row] = await db.select().from(channelCharacters).where(eq(channelCharacters.id, id));
    const source = row ? (row.masters as ChannelMasters)[m.masterKey] : undefined;
    if (!source || source.story_id === storyId) continue;
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, source.asset_id), eq(assets.status, "ready")));
    if (!asset) continue;
    let body: Buffer;
    try {
      body = await getStorage().get(asset.storageKey);
    } catch {
      continue;
    }
    const copy = await createAsset(db, {
      storyId,
      taskId: null,
      assetKey: `master/${m.masterKey}`,
      contentType: asset.contentType,
      status: "pending",
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      meta: { reused_from: { story_id: source.story_id, asset_id: asset.id } },
    });
    await getStorage().put(copy.storageKey, body, asset.contentType);
    await db.update(assets).set({ status: "ready" }).where(eq(assets.id, copy.id));
    await db
      .update(storyMasters)
      .set({ status: "approved", approvedAssetId: copy.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(storyMasters.storyId, storyId), eq(storyMasters.masterKey, m.masterKey)));
    reused.push(m.masterKey);
  }
  if (reused.length) {
    await logEvent(db, { storyId }, null, "info", `Reused ${reused.length} channel character sheet(s): ${reused.join(", ")}.`);
  }
  return reused;
}
