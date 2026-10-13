import { botConsoleSession } from "@/lib/auth";
import { BotConsole } from "./console";

export default async function BotPage({ searchParams }: PageProps<"/bot">) {
  const params = await searchParams;
  const session = await botConsoleSession();
  if (!session) {
    return (
      <main className="dot-grid flex flex-1 items-center justify-center p-6">
        <form action="/api/auth/login" method="post" className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-line bg-background p-8">
          <div>
            <span className="eyebrow">Slideshow Storytelling</span>
            <h1 className="mt-2 text-3xl font-bold tracking-tight">Bot console</h1>
          </div>
          {params.error && <p className="text-sm text-bad">That token is not a valid bot token.</p>}
          <input
            type="hidden"
            name="next"
            value={typeof params.task === "string" ? `/bot?task=${params.task}&lease=${params.lease ?? ""}` : "/bot"}
          />
          <input className="input font-mono" type="password" name="bot_token" placeholder="Bot token" autoFocus required />
          <button className="btn-primary py-2">Open console</button>
          <a href="/api/bot/runbook" className="link text-xs text-muted">
            Read the runbook
          </a>
        </form>
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 p-6">
      <BotConsole
        resumeTask={typeof params.task === "string" ? params.task : null}
        resumeLease={typeof params.lease === "string" ? params.lease : null}
      />
    </main>
  );
}
