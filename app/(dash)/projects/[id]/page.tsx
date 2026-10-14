import { connection } from "next/server";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { episodeHref } from "@/lib/episode/naming";

/** Old project links open the episode version inside its story folder. */
export default async function ProjectRedirect({ params }: PageProps<"/projects/[id]">) {
  await connection();
  const { id } = await params;
  const [p] = await (await getDb())
    .select({ storyId: projects.storyId, n: projects.episodeNumber, v: projects.version })
    .from(projects)
    .where(eq(projects.id, id));
  if (!p?.storyId) notFound();
  redirect(episodeHref(p.storyId, p.n, p.v));
}
