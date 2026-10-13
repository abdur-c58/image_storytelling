/**
 * Stand-in for the Grok browser bot. Claims bot tasks over the real HTTP API, uploads placeholder
 * images for generate_images and pretends to publish for upload_youtube.
 *
 *   BOT_TOKEN=... APP_BASE_URL=http://localhost:3000 npx tsx scripts/fake-bot.ts [--once] [--interval 5]
 */
import sharp from "sharp";

const base = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const token = process.env.BOT_TOKEN || "";
const once = process.argv.includes("--once");
const intervalArg = process.argv.indexOf("--interval");
const intervalSec = intervalArg > 0 ? Number(process.argv[intervalArg + 1]) : 5;

if (!token) {
  console.error("Set BOT_TOKEN.");
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}`, "x-agent-id": "fake-bot" };

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (res.status === 204) return null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}: ${body.error ?? text}`);
  return body;
}

const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

async function placeholder(label: string, prompt: string): Promise<Buffer> {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const words = prompt.split(/\s+/).slice(-24).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,18%)"/>
    </linearGradient></defs>
    <rect width="1920" height="1080" fill="url(#g)"/>
    <circle cx="1500" cy="300" r="180" fill="hsl(${(hue + 180) % 360},50%,60%)" opacity="0.5"/>
    <rect x="200" y="700" width="700" height="220" rx="30" fill="hsl(${(hue + 120) % 360},40%,50%)" opacity="0.6"/>
    <text x="80" y="160" font-family="Arial" font-size="110" font-weight="bold" fill="#fff">${escapeXml(label)}</text>
    <text x="80" y="260" font-family="Arial" font-size="34" fill="#eee">${escapeXml(words.slice(0, 110))}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

interface Item {
  segment_id: string;
  asset_key: string;
  final_prompt: string;
  already_uploaded?: boolean;
}

async function doImages(task: { task_id: string; lease_id: string; payload: { items: Item[] } }) {
  const items = task.payload.items;
  let done = 0;
  for (const item of items) {
    if (item.already_uploaded) {
      done++;
      continue;
    }
    const png = await placeholder(item.asset_key, item.final_prompt);
    const form = new FormData();
    form.set("lease_id", task.lease_id);
    form.set("asset_key", item.asset_key);
    form.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), `${item.segment_id}.png`);
    const res = await call(`/api/bot/tasks/${task.task_id}/assets`, { method: "POST", body: form });
    if (!res.accepted) throw new Error(`Upload of ${item.asset_key} rejected: ${res.reason}`);
    done++;
    await post(`/api/bot/tasks/${task.task_id}/heartbeat`, {
      lease_id: task.lease_id,
      progress: { completed_items: done, total_items: items.length },
    });
  }
  const result = await post(`/api/bot/tasks/${task.task_id}/complete`, { lease_id: task.lease_id, result: {} });
  console.log(`  uploaded ${done}/${items.length}${result.missing?.length ? `, missing ${result.missing.join(", ")}` : ""}`);
}

async function doPublish(task: { task_id: string; lease_id: string; payload: Record<string, unknown> }) {
  const p = task.payload;
  for (const key of ["video_download_url", "thumbnail_download_url"]) {
    const url = p[key];
    if (typeof url !== "string") throw new Error(`Payload is missing ${key}.`);
    const res = await fetch(url, { redirect: "follow" });
    const bytes = (await res.arrayBuffer()).byteLength;
    if (!res.ok || bytes === 0) throw new Error(`Could not download ${key} (HTTP ${res.status}).`);
    console.log(`  downloaded ${key}: ${bytes} bytes`);
  }
  console.log(`  would publish "${p.title}" as ${p.visibility}`);
  const id = `FAKE${Math.random().toString(36).slice(2, 9)}`;
  await post(`/api/bot/tasks/${task.task_id}/complete`, {
    lease_id: task.lease_id,
    result: { youtube_url: `https://youtu.be/${id}`, visibility_set: p.visibility, notes: "fake-bot" },
  });
}

async function main() {
  console.log(`fake-bot polling ${base}`);
  for (;;) {
    let task;
    try {
      task = await call("/api/bot/tasks/next");
    } catch (error) {
      console.error((error as Error).message);
    }
    if (task) {
      console.log(`claimed ${task.type} (${task.scope}) for "${task.project_title}"`);
      try {
        if (task.type === "generate_images") await doImages(task);
        else if (task.type === "upload_youtube") await doPublish(task);
        else throw new Error(`Unknown task type ${task.type}`);
      } catch (error) {
        console.error(`  failed: ${(error as Error).message}`);
        await post(`/api/bot/tasks/${task.task_id}/fail`, {
          lease_id: task.lease_id,
          reason: (error as Error).message,
          retryable: true,
        }).catch(() => undefined);
      }
      continue;
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

void main();
