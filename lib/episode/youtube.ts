/**
 * Length of the tag list as YouTube Studio counts it: tags joined by commas,
 * and any tag containing a space is wrapped in quotes (2 extra characters).
 */
export function youtubeTagsLength(tags: string[]): number {
  const cleaned = tags.map((tag) => tag.trim()).filter(Boolean);
  if (cleaned.length === 0) return 0;
  const body = cleaned.reduce((sum, tag) => sum + tag.length + (/\s/.test(tag) ? 2 : 0), 0);
  return body + (cleaned.length - 1);
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** YouTube rejects angle brackets in titles and descriptions. */
export function hasForbiddenYoutubeChars(text: string): boolean {
  return /[<>]/.test(text);
}

export function formatYoutubeTimestamp(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

export interface ChapterInput {
  title: string;
  start_seconds: number;
}

export const MIN_CHAPTERS = 3;
export const MIN_CHAPTER_SECONDS = 10;

/** Same rules as the Billions publish queue: >=3 chapters, first at 0:00, each >=10 s. */
export function chapterProblem(chapters: ChapterInput[], durationSeconds: number): string | null {
  if (chapters.length < MIN_CHAPTERS) {
    return `YouTube needs at least ${MIN_CHAPTERS} chapters; found ${chapters.length}.`;
  }
  if (chapters[0].start_seconds > 0) return "First chapter must start at 0:00.";
  for (let i = 0; i < chapters.length; i++) {
    const end = i + 1 < chapters.length ? chapters[i + 1].start_seconds : durationSeconds;
    if (end - chapters[i].start_seconds < MIN_CHAPTER_SECONDS) {
      return `Chapter "${chapters[i].title}" is shorter than ${MIN_CHAPTER_SECONDS} seconds.`;
    }
  }
  return null;
}

export function chaptersText(chapters: ChapterInput[]): string {
  return chapters.map((c) => `${formatYoutubeTimestamp(c.start_seconds)} ${c.title}`).join("\n");
}
