import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { getStory } from "@/lib/pipeline/story";
import { PageHeader } from "../ui";
import { EpisodeEditor } from "./editor";

export default async function NewEpisodePage({ searchParams }: PageProps<"/new">) {
  const { draft, story: storyParam } = await searchParams;
  const storyId = typeof storyParam === "string" ? storyParam : null;
  const scoped = storyId ? await getStory(await getDb(), storyId) : null;
  const scope = scoped && scoped.status !== "deleted" ? { id: scoped.id, title: scoped.title } : null;
  const dir = path.join(process.cwd(), "fixtures");
  const read = (name: string) => readFile(path.join(dir, name), "utf8").catch(() => "");
  const [story, minimal, full] = await Promise.all([
    read("story_bible_example.json"),
    read("episode_minimal.json"),
    read("episode_full.json"),
  ]);
  return (
    <>
      <PageHeader eyebrow={scope ? scope.title : "Create"} title={scope ? "Add to this story" : "New story or episode"} />
      <p className="-mt-4 mb-8 max-w-2xl font-light text-muted">
        {scope ? (
          <>
            Documents pasted here must belong to{" "}
            <Link href={`/stories/${scope.id}`} className="link">
              {scope.title}
            </Link>{" "}
            (<code className="font-mono text-xs">story_id: &quot;{scope.id}&quot;</code>).{" "}
          </>
        ) : (
          <>
            Paste a story bible, an episode, or a bundle of both from Claude, or drop the file in. Each document files itself
            into its story from <code className="font-mono text-xs">story_id</code> and{" "}
            <code className="font-mono text-xs">episode_number</code>.{" "}
          </>
        )}
        Episodes are checked against the story state after the previous episode. Errors block saving, warnings don&apos;t.
        Schemas at{" "}
        <a className="link" href="/api/schema?type=story_bible">
          story_bible
        </a>
        ,{" "}
        <a className="link" href="/api/schema?type=episode">
          episode
        </a>{" "}
        and{" "}
        <a className="link" href="/api/schema?type=bundle">
          bundle
        </a>
        .
      </p>
      <EpisodeEditor examples={{ story, minimal, full }} loadDraft={draft === "1"} scope={scope} />
    </>
  );
}
