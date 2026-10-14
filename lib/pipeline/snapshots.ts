import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { episodes, stories, storyStateSnapshots } from "@/lib/db/schema";
import { initialSnapshot, type StoryState, type StoryStateSnapshot } from "@/lib/episode/continuity";
import type { StoryBible } from "@/lib/episode/schema";

/** Snapshots of each episode's active version, in episode order. */
export async function activeSnapshots(db: Db, storyId: string): Promise<{ episodeNumber: number; version: number; projectId: string; state: StoryStateSnapshot }[]> {
  const rows = await db
    .select({
      episodeNumber: storyStateSnapshots.episodeNumber,
      version: storyStateSnapshots.version,
      projectId: storyStateSnapshots.projectId,
      state: storyStateSnapshots.state,
    })
    .from(storyStateSnapshots)
    .innerJoin(episodes, and(eq(episodes.activeVersionId, storyStateSnapshots.projectId), eq(episodes.storyId, storyId)))
    .where(eq(storyStateSnapshots.storyId, storyId))
    .orderBy(asc(storyStateSnapshots.episodeNumber));
  return rows.map((r) => ({ ...r, state: r.state as StoryStateSnapshot }));
}

export function storyStateFrom(bible: StoryBible, snapshots: { episodeNumber: number; state: StoryStateSnapshot }[]): StoryState {
  const by_episode: Record<string, StoryStateSnapshot> = {};
  for (const s of snapshots) by_episode[String(s.episodeNumber)] = { ...s.state, after_episode: s.episodeNumber };
  const latest = snapshots.at(-1);
  return {
    current: latest ? by_episode[String(latest.episodeNumber)] : initialSnapshot(bible),
    by_episode,
    committed_through_episode: latest?.episodeNumber ?? 0,
  };
}

/** The story state every episode is validated against: built from the active versions' snapshots. */
export async function computeStoryState(db: Db, storyId: string, bible: StoryBible): Promise<StoryState> {
  return storyStateFrom(bible, await activeSnapshots(db, storyId));
}

/** stories.story_state is a cache of computeStoryState for exports and older readers. */
export async function refreshStoryStateCache(db: Db, storyId: string): Promise<StoryState | null> {
  const [story] = await db.select({ bible: stories.bible }).from(stories).where(eq(stories.id, storyId));
  if (!story?.bible) return null;
  const state = await computeStoryState(db, storyId, story.bible as StoryBible);
  await db.update(stories).set({ storyState: state }).where(eq(stories.id, storyId));
  return state;
}

export async function recordSnapshot(
  db: Db,
  row: { projectId: string; storyId: string; episodeNumber: number; version: number },
  state: StoryStateSnapshot,
): Promise<void> {
  const value = { ...state, after_episode: row.episodeNumber };
  await db
    .insert(storyStateSnapshots)
    .values({ ...row, state: value })
    .onConflictDoUpdate({ target: storyStateSnapshots.projectId, set: { state: value, updatedAt: new Date() } });
}
