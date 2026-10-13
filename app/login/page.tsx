import { adminConfigured } from "@/lib/session";
import { ThemeToggle } from "../theme-toggle";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "";
  return (
    <main className="dot-grid relative flex flex-1 items-center justify-center p-6">
      <div className="absolute top-5 right-6">
        <ThemeToggle />
      </div>
      <form action="/api/auth/login" method="post" className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-background p-8">
        <div>
          <span className="eyebrow">Slideshow Storytelling</span>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">Sign in</h1>
        </div>
        {!adminConfigured() && (
          <p className="text-sm text-warn">ADMIN_PASSWORD is not set. Set it in the environment before deploying.</p>
        )}
        {params.error && <p className="text-sm text-bad">Wrong password.</p>}
        <input type="hidden" name="next" value={next} />
        <input className="input" type="password" name="password" placeholder="Admin password" autoFocus required />
        <button className="btn-primary py-2">Sign in</button>
        <p className="text-xs font-light text-muted">
          Bot operators: use the{" "}
          <a className="link" href="/bot">
            bot console
          </a>{" "}
          with a bot token instead.
        </p>
      </form>
    </main>
  );
}
