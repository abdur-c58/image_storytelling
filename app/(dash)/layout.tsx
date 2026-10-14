import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { folderTree } from "@/lib/pipeline/folders";
import { ThemeToggle } from "../theme-toggle";
import { NavLinks } from "./nav";
import { SidebarTree } from "./sidebar";

export default async function DashLayout({ children }: LayoutProps<"/">) {
  if (!(await isAdmin())) redirect("/login");
  const tree = await folderTree(await getDb());
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-background/80 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link href="/stories" className="hidden text-lg font-bold tracking-tight sm:block">
            Slideshow
          </Link>
          <NavLinks />
          <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
            {env.dryRun && <span className="chip hidden border-warn/40 text-warn md:inline-flex">Dry run</span>}
            <form action="/api/auth/logout" method="post">
              <button className="text-sm text-muted transition-colors hover:text-foreground">Sign out</button>
            </form>
            <ThemeToggle />
          </div>
        </nav>
      </header>
      <div className="flex flex-1">
        <SidebarTree stories={tree} />
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-6 py-10">{children}</main>
      </div>
    </div>
  );
}
