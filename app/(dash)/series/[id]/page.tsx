import { redirect } from "next/navigation";

/** A series is a story folder since schema 2.3 (series_id = story_id). */
export default async function SeriesRedirect({ params }: PageProps<"/series/[id]">) {
  const { id } = await params;
  redirect(`/stories/${encodeURIComponent(decodeURIComponent(id))}`);
}
