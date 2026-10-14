import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { episodes, projects, stories } from "@/lib/db/schema";
import { outputBasename } from "@/lib/episode/naming";

/** Which story and episode a task belongs to: sent with every bot/worker task and used in file names and logs. */
export interface TaskContext {
  story_id: string | null;
  story_title: string | null;
  episode_number: number | null;
  episode_title: string | null;
  version: number | null;
  /** Stem for output files, e.g. the-rising-ep01-v1-day-one (null for story tasks). */
  output_basename: string | null;
}

const EMPTY: TaskContext = { story_id: null, story_title: null, episode_number: null, episode_title: null, version: null, output_basename: null };

export async function projectContext(db: Db, projectId: string): Promise<TaskContext> {
  const [row] = await db
    .select({
      storyId: projects.storyId,
      storyTitle: stories.title,
      number: projects.episodeNumber,
      version: projects.version,
      episodeTitle: episodes.title,
      projectTitle: projects.title,
    })
    .from(projects)
    .leftJoin(stories, eq(stories.id, projects.storyId))
    .leftJoin(episodes, eq(episodes.id, projects.episodeId))
    .where(eq(projects.id, projectId));
  if (!row) return EMPTY;
  const episodeTitle = row.episodeTitle ?? row.projectTitle;
  return {
    story_id: row.storyId,
    story_title: row.storyTitle,
    episode_number: row.number,
    episode_title: episodeTitle,
    version: row.version,
    output_basename: row.storyId ? outputBasename(row.storyId, row.number, row.version, episodeTitle) : null,
  };
}

export async function storyContext(db: Db, storyId: string): Promise<TaskContext> {
  const [row] = await db.select({ title: stories.title }).from(stories).where(eq(stories.id, storyId));
  return { ...EMPTY, story_id: storyId, story_title: row?.title ?? null };
}

export async function taskContext(db: Db, owner: { projectId: string | null; storyId: string | null }): Promise<TaskContext> {
  if (owner.projectId) return projectContext(db, owner.projectId);
  if (owner.storyId) return storyContext(db, owner.storyId);
  return EMPTY;
}

/** "the-rising ep01 v1" — prefix for log lines. */
export function contextTag(c: TaskContext): string {
  if (!c.story_id) return "";
  return c.episode_number ? `${c.story_id} ep${String(c.episode_number).padStart(2, "0")} v${c.version}` : c.story_id;
}
