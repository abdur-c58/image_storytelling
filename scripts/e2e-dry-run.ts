/**
 * End-to-end dry run: story bible + episode bundle -> location masters (approved here) -> PUBLISHED, then
 * ffprobe the final MP4 and check the crop plan reached the timeline.
 *
 *   npm run e2e [episode.json] [--all-features] [--no-masters]
 *
 * Starts `next dev` on a throwaway PGlite database and local storage, the fake bot and the Python
 * worker with DRY_RUN=1 (no Fish Audio, Whisper, Openverse or YouTube calls). Needs ffmpeg/ffprobe,
 * node, python and `npm install` in the worker's remotion/ folder. The worker lives in
 * ../story-telling-worker (override with STORY_WORKER_DIR).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.E2E_PORT ?? 3123);
const base = `http://localhost:${port}`;
const runDir = path.join(root, ".data", `e2e-${Date.now()}`);
const storageDir = path.join(runDir, "storage");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fixture = positional[0] ?? path.join(root, "fixtures", "episode_minimal.json");
const storyFixture = path.join(root, "fixtures", "story_bible_example.json");
/** --all-features: also burn in captions and add an outro, to exercise more of the renderer. */
const allFeatures = process.argv.includes("--all-features");
/** --no-masters: switch the location-masters gate off (episode pictures start immediately). */
const noMasters = process.argv.includes("--no-masters");
const timeoutMin = Number(process.env.E2E_TIMEOUT_MIN ?? 20);
const python = process.env.PYTHON ?? "python";
const workerDir = path.resolve(process.env.STORY_WORKER_DIR ?? path.join(root, "..", "story-telling-worker"));
const password = randomBytes(12).toString("hex");
const botToken = `bot_${randomBytes(24).toString("hex")}`;
const workerToken = `wkr_${randomBytes(24).toString("hex")}`;
const children: ChildProcess[] = [];

interface ProjectStatus {
  state: string;
  state_detail: string;
  error: string | null;
  outputs: Record<string, unknown>;
  youtube_url: string | null;
}

function start(name: string, cmd: string, args: string[], env: Record<string, string>, cwd = root): ChildProcess {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => `[${name}] ${l}`)
      .join("\n");
  child.stdout?.on("data", (c: Buffer) => console.log(prefix(c)));
  child.stderr?.on("data", (c: Buffer) => console.log(prefix(c)));
  child.on("exit", (code) => console.log(`[${name}] exited with ${code}`));
  children.push(child);
  return child;
}

function stopAll() {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGTERM");
  }
  // next dev's server process can outlive the killed tree on Windows; free the port too.
  if (process.platform === "win32") {
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
    const pids = new Set(
      (netstat.stdout ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((f) => f[1]?.endsWith(`:${port}`) && f[3] === "LISTENING")
        .map((f) => f[4]),
    );
    for (const pid of pids) spawnSync("taskkill", ["/pid", pid, "/T", "/F"], { stdio: "ignore" });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(site: ChildProcess) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (site.exitCode !== null) throw new Error(`dev server exited with ${site.exitCode}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("dev server did not become healthy in 3 minutes");
}

async function login(): Promise<string> {
  const form = new URLSearchParams({ password });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", body: form, redirect: "manual" });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ss_admin="));
  if (!cookie) throw new Error(`admin login failed (HTTP ${res.status})`);
  return cookie.split(";")[0];
}

function findFiles(dir: string, test: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) findFiles(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

async function main() {
  if (!existsSync(path.join(workerDir, "slideshow_worker"))) {
    throw new Error(`worker not found in ${workerDir}; set STORY_WORKER_DIR`);
  }
  const taken = await fetch(`${base}/api/health`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`port ${port} is already in use (a leftover e2e server?); stop it or set E2E_PORT`);
  mkdirSync(storageDir, { recursive: true });
  const siteEnv = {
    DATABASE_URL: `pglite:${path.join(runDir, "pglite")}`,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: storageDir,
    APP_BASE_URL: base,
    ADMIN_PASSWORD: password,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    BOT_TOKEN: botToken,
    WORKER_TOKEN: workerToken,
    BOT_LEASE_SEC: "300",
    WORKER_LEASE_SEC: "180",
    DRY_RUN: "1",
    NEXT_DIST_DIR: ".next-e2e",
  };
  const site = start("site", process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port)], siteEnv);
  await waitForHealth(site);
  const cookie = await login();

  // Render/publish gates would wait for a click, so the unattended run switches them off. Masters are
  // approved below through the admin API, the way an operator would on the Story page.
  const episode = JSON.parse(readFileSync(fixture, "utf8"));
  const bible = JSON.parse(readFileSync(storyFixture, "utf8"));
  if (noMasters) bible.automation.approval_gates.location_masters = false;
  episode.automation = { ...episode.automation, approval_gates: { before_render: false, before_publish: false } };
  if (allFeatures) {
    episode.overrides = { ...episode.overrides, render: { burn_in_captions: true, caption_style: "bottom_bar", outro_sec: 1.5 } };
  }
  const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: bible, episode };
  const res = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(bundle, null, 2),
  });
  const created = (await res.json()) as { id?: string; story_id?: string; error?: string; errors?: unknown };
  if (!res.ok || !created.id) throw new Error(`create failed: ${JSON.stringify(created)}`);
  console.log(`[e2e] story ${created.story_id}, project ${created.id}`);

  start("bot", process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/fake-bot.ts", "--interval", "2"], {
    APP_BASE_URL: base,
    BOT_TOKEN: botToken,
  });
  start("worker", python, ["-m", "slideshow_worker", "run"], {
    APP_BASE_URL: base,
    WORKER_TOKEN: workerToken,
    WORKER_AGENT_ID: "e2e-worker",
    DRY_RUN: "1",
    POLL_INTERVAL_SEC: "2",
    POLL_MAX_INTERVAL_SEC: "2",
    WORK_DIR: path.join(runDir, "worker"),
    PYTHONUNBUFFERED: "1",
  }, workerDir);

  const deadline = Date.now() + timeoutMin * 60_000;
  let last = "";
  let status: ProjectStatus | null = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await fetch(`${base}/api/projects/${created.id}`, { headers: { cookie } });
    const current = (await r.json()) as ProjectStatus;
    status = current;
    const line = `${current.state} ${current.state_detail}`;
    if (line !== last) console.log(`[e2e] ${line}`);
    last = line;
    if (current.state === "PUBLISHED" || current.state === "FAILED") break;
    if (current.state === "WAITING_MASTERS") {
      const s = (await (await fetch(`${base}/api/stories/${created.story_id}`, { headers: { cookie } })).json()) as {
        masters: { status: string }[];
      };
      if (s.masters.some((m) => m.status === "generated")) {
        const a = await fetch(`${base}/api/stories/${created.story_id}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ action: "approve_all_masters" }),
        });
        console.log(`[e2e] approved masters: ${JSON.stringify(await a.json())}`);
      }
    }
  }
  if (!status || status.state !== "PUBLISHED") throw new Error(`project ended in ${status?.state}: ${status?.error ?? "timeout"}`);
  const crop = status.outputs.crop as { segments: Record<string, { sentences: unknown[]; crop_plan: { kind: string }[] }> } | undefined;
  if (!crop) throw new Error("no crop plan was written after alignment");
  const crops = Object.values(crop.segments).reduce((n, s) => n + s.crop_plan.filter((k) => k.kind === "crop").length, 0);
  console.log(`[e2e] crop plan: ${crops} crop(s) over ${Object.keys(crop.segments).length} segments`);
  const story = (await (await fetch(`${base}/api/stories/${created.story_id}`, { headers: { cookie } })).json()) as {
    story_state: { committed_through_episode: number };
  };
  if (story.story_state.committed_through_episode < episode.series.episode_number) throw new Error("story state was not committed on publish");

  const finals = findFiles(storageDir, (p) => p.endsWith(".mp4") && p.split(path.sep).includes("final"));
  if (finals.length !== 1) throw new Error(`expected one final video, found ${finals.length}`);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", finals[0]], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`ffprobe rejected ${finals[0]}: ${probe.stderr}`);
  const info = JSON.parse(probe.stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  console.log(`[e2e] final ${finals[0]}`);
  console.log(`[e2e] video ${v?.codec_name} ${v?.width}x${v?.height}, audio ${a?.codec_name}, ${Number(info.format.duration).toFixed(2)}s`);
  console.log(`[e2e] mix ${JSON.stringify(status.outputs.mix_report)}`);
  console.log(`[e2e] youtube ${status.youtube_url}`);
  if (v?.codec_name !== "h264" || v.width !== 1920 || v.height !== 1080 || a?.codec_name !== "aac") throw new Error("final video has the wrong format");
  console.log("[e2e] PASS");
}

main()
  .then(() => {
    stopAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[e2e] FAIL: ${err instanceof Error ? err.message : err}`);
    stopAll();
    process.exit(1);
  });
