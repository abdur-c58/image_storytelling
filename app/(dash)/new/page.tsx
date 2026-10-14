import { readFile } from "node:fs/promises";
import path from "node:path";
import { PageHeader } from "../ui";
import { EpisodeEditor } from "./editor";

export default async function NewEpisodePage({ searchParams }: PageProps<"/new">) {
  const { draft } = await searchParams;
  const dir = path.join(process.cwd(), "fixtures");
  const read = (name: string) => readFile(path.join(dir, name), "utf8").catch(() => "");
  const [story, minimal, full] = await Promise.all([
    read("story_bible_example.json"),
    read("episode_minimal.json"),
    read("episode_full.json"),
  ]);
  return (
    <>
      <PageHeader eyebrow="Create" title="New story or episode" />
      <p className="-mt-4 mb-8 max-w-2xl font-light text-muted">
        Paste a story bible, an episode, or a bundle of both from Claude, or drop the file in. The document type is detected
        from <code className="font-mono text-xs">doc_type</code>. Episodes are checked against their story&apos;s stored
        continuity. Errors block saving, warnings don&apos;t. Schemas at{" "}
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
      <EpisodeEditor examples={{ story, minimal, full }} loadDraft={draft === "1"} />
    </>
  );
}
