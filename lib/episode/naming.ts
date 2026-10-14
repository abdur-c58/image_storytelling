/** Story folder slugs, episode labels and output file names (schema 2.3). Safe for client components. */

export const STORY_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const UNSORTED_STORY_ID = "unsorted";

export function slugify(text: string, max = 64): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug;
}

export function isStorySlug(s: string): boolean {
  return s.length >= 1 && s.length <= 64 && STORY_SLUG_RE.test(s);
}

export const epCode = (n: number) => `ep${String(n).padStart(2, "0")}`;

/** "Ep 3: Day One" */
export const episodeLabel = (n: number, title: string) => `Ep ${n}: ${title}`;

/** File stem for an episode version's outputs: the-rising-ep01-v2-day-one */
export function outputBasename(storyId: string, episodeNumber: number, version: number, episodeTitle: string): string {
  const title = slugify(episodeTitle, 40);
  return [storyId, epCode(episodeNumber), `v${version}`, title].filter(Boolean).join("-");
}

export function episodeHref(storyId: string, episodeNumber: number, version?: number): string {
  const base = `/stories/${encodeURIComponent(storyId)}/episodes/${episodeNumber}`;
  return version ? `${base}?v=${version}` : base;
}
