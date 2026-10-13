import { readFile } from "node:fs/promises";
import path from "node:path";
import { PageHeader } from "../ui";
import { EpisodeEditor } from "./editor";

export default async function NewEpisodePage({ searchParams }: PageProps<"/new">) {
  const { draft } = await searchParams;
  const dir = path.join(process.cwd(), "fixtures");
  const [minimal, full] = await Promise.all([
    readFile(path.join(dir, "minimal_3_segments.json"), "utf8").catch(() => ""),
    readFile(path.join(dir, "full_example.json"), "utf8").catch(() => ""),
  ]);
  return (
    <>
      <PageHeader eyebrow="Create" title="New episode" />
      <p className="-mt-4 mb-8 max-w-2xl font-light text-muted">
        Paste the episode JSON from Claude, or drop the file in. It&apos;s checked as you type: errors block creating the project,
        warnings don&apos;t. Schema at{" "}
        <a className="link" href="/api/schema">
          /api/schema
        </a>
        .
      </p>
      <EpisodeEditor examples={{ minimal, full }} loadDraft={draft === "1"} />
    </>
  );
}
