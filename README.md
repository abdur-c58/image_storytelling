# Slideshow Storytelling

Paste one episode JSON, get a finished YouTube video: AI images (Google Flow, via the Grok bot), Fish Audio narration, licensed sound effects, Remotion cards and thumbnail, a loudness-checked mix, an H.264 render, and an upload to YouTube Studio (also via the bot).

```text
             paste JSON                               poll over HTTPS (outbound only)
  you ──────────────────▶  Website (Next.js, Vercel)  ◀──────────────────────────┐
                            │  Supabase Postgres: projects, tasks, assets       │
                            │  R2: slideshow-storytelling/…  (presigned URLs)   │
                            ▼                                                   │
                   task queue with leases                                       │
                 ┌──────────┴───────────┐                                       │
        Grok bot (browser)        Worker (GPU PC, Python)  ───────────────────────┘
   generate_images (Google Flow)  voice · align · sfx · cards · thumbnail · mix · render
   upload_youtube (Studio)        imports the existing server's Fish/Whisper/ffmpeg code
```

Nothing calls into the bot or the worker; both poll the site, so the PC needs no tunnel or open port.

## Pipeline

| State | What happens | Who |
|---|---|---|
| `DRAFT` | Saved, not started (`automation.auto_start_on_submit: false`). | – |
| `VALIDATED` | Accepted; tasks are queued. | site |
| `GENERATING` | In parallel: `generate_images`, `voice` → `align`, `sfx`, `cards` (once their background images exist). Images are retried per item; only missing ones are asked for again. | bot, worker |
| `MIX` | Voice stem → −16 LUFS, SFX placed (beds looped and ducked), master → −14 LUFS / −1.5 dBTP. Fails if more than ±1 LU off. Writes `mix_report.json`. | worker |
| `IMAGES_RECEIVED` / `THUMBNAIL` | Thumbnail base generated, text composed (runs alongside the mix). | bot, worker |
| `RENDER` | Ken-Burns clips, transitions, NVENC (or libx264) encode, ffprobe check, preview copy. | worker |
| `REVIEW` | Waiting at an approval gate (`before_render` or `before_publish`), if enabled. | you |
| `PUBLISH_REQUESTED` → `PUBLISHED` | Bot uploads with the exact title/description/visibility and reports the URL. | bot |
| `FAILED` | A task hit its retry limit. Fix, then **Retry** in the project page. | – |

To start episodes without the editor, drop one or more episode JSON files onto the **Projects** page (or use **Choose files**). A dialog asks how automation should run: **Run to YouTube** (no stops), **Review before publishing** (waits for your approval before upload), **Import only** (draft), or **Use each file's own settings**. If a series/episode number already exists, it offers to replace it (the old project is archived and its queued tasks cancelled). Invalid files are listed with their first error and a **Fix in editor** button.

Stages run as soon as their inputs exist, so several can be active at once; the badge shows the furthest one. Every step is resumable: tasks are leased with heartbeats; a crashed agent's lease expires and the task is retried with backoff, then dead-lettered. Outputs are content-addressed (sha256), so re-runs skip work that already exists. The project page can regenerate one image, one voice line, the thumbnail, or swap an SFX choice, and only the affected downstream stages re-run.

## Repository layout

| Path | What |
|---|---|
| `app/`, `lib/`, `proxy.ts` | Website: dashboard, episode editor with live validation, bot console (`/bot`), bot/worker APIs. |
| `lib/episode/` | Zod schema (source of truth), validator with line/column errors, prompt assembly. JSON Schema export in `schema/episode.schema.json`. |
| `lib/pipeline/` | State machine (`advance.ts`), task payloads, completion handling, description/chapters/credits. |
| `drizzle/` | SQL migrations. |
| `../story-telling-worker/` | Not in this repo. Python worker (`python -m slideshow_worker`) and its `remotion/` project (card templates, icons, thumbnail composition). Runs on the GPU PC; never deployed to Vercel. |
| `bot/RUNBOOK.md` | Instructions for the Grok bot (served at `/api/bot/runbook`). |
| `scripts/fake-bot.ts` | Stand-in bot for testing (placeholder images, fake YouTube URL). |
| `scripts/e2e-dry-run.ts` | Full end-to-end test. |
| `fixtures/` | `minimal_3_segments.json`, `full_example.json`. |
| `docs/` | `EXISTING_SERVER_AUDIT.md`, `CLAUDE_SCRIPT_CONTRACT.md` (give this to Claude when writing episodes). |

## Local development

Requirements: Node 24, Python 3.12, ffmpeg/ffprobe on `PATH`, and two folders next to this repo: the existing server (`../server`) and the worker (`../story-telling-worker`).

```powershell
npm install
cd ..\story-telling-worker\remotion; npm install; cd ..\..\slideshow_storytelling
pip install -r ..\story-telling-worker\requirements.txt   # plus openai-whisper for real alignment
copy .env.example .env.local                # everything can stay empty for local dev
npm run dev                                 # http://localhost:3000 (PGlite + local storage)
```

With no `DATABASE_URL` the site uses an embedded PGlite database in `.data/pglite`; with no R2 settings files go to `.data/storage`. With no `ADMIN_PASSWORD` the dashboard is open in development (never in production).

### Dry run (no paid APIs)

```powershell
npm run e2e
```

Starts a throwaway site, the fake bot and the worker with `DRY_RUN=1`, runs `fixtures/minimal_3_segments.json` to `PUBLISHED` and checks the final MP4 with ffprobe (H.264 1920×1080 + AAC). Takes about a minute. `npm run e2e -- fixtures/full_example.json --all-features` runs the 13-image example with every transition, motion, burned-in captions and an outro (about 2 minutes; approval gates are switched off for the run). Output stays in `.data/e2e-<timestamp>/`. To watch it in the browser instead, run `npm run dev` with `DRY_RUN=1`, then in two more terminals:

```powershell
$env:BOT_TOKEN="<bot token>"; npm run fake-bot
$env:WORKER_TOKEN="<worker token>"; $env:DRY_RUN="1"; npm run worker
```

### Tests

```powershell
npm test               # schema, validator, queue/state machine on in-memory Postgres
npm run test:worker    # timeline, captions, WER, SFX licence filter and ranking
npm run typecheck
npm run e2e
```

## Production setup

1. **Supabase**: create a project. Use the *transaction pooler* connection string (port 6543) as `DATABASE_URL`. Either set `AUTO_MIGRATE=1` or run `npm run db:migrate` once against the *direct* connection string.
2. **R2**: reuse the existing bucket. Create an API token with Object Read & Write on that bucket. Everything goes under `slideshow-storytelling/`. Add a CORS rule so the bot console can upload from the browser:

   ```json
   [{ "AllowedOrigins": ["https://your-app.vercel.app"], "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```

3. **Vercel**: import the repo, set the variables from `.env.example` (`SESSION_SECRET`, `ADMIN_PASSWORD`, `APP_BASE_URL`, `CRON_SECRET`, database and R2). `vercel.json` schedules `/api/cron/maintenance` daily (expired leases, intermediate clean-up).
4. **Tokens**: sign in, open **Settings → Tokens**, create one `worker` token and one `bot` token. They are shown once and stored hashed. Revoke and recreate to rotate.
5. **Worker** (GPU PC, `..\story-telling-worker`): copy its `.env.example` to `.env`, fill `APP_BASE_URL` and `WORKER_TOKEN`, then (from this repo, or `python -m slideshow_worker selfcheck|run` inside the worker folder):

   ```powershell
   npm run worker:selfcheck   # tools, server imports, which keys are set (never their values)
   npm run worker
   ```

   Fish Audio keys come from the existing server's `.env.local`. Run it as a scheduled task or in a terminal that stays open.
6. **Bot**: give it the bot token and `https://your-app.vercel.app/api/bot/runbook`. It can use the JSON API or the `/bot` console page.

## Sound effects and licensing

The channel is monetised, so only clips that allow commercial use in a video are accepted:

| Source | Used | Notes |
|---|---|---|
| Local library | first | Folders you own a licence for. Each needs `SFX_LICENSE.json` with `"commercial_use": true`, or indexing refuses. `python -m slideshow_worker index-sfx <folder>` |
| Openverse | default | Filtered to CC0, Public Domain Mark and CC BY. BY-SA/BY-ND (a synced video is an adaptation), NC and Sampling+ are rejected. CC BY credits are added to the description automatically. |
| Freesound API | opt-in | `FREESOUND_ENABLED=1`. Freesound's API terms require a separate agreement for commercial use; only enable it if you have one. |
| ElevenLabs | opt-in | `ELEVENLABS_SFX_ENABLED=1`; generated clips, commercial use on paid plans. |

Not used: BBC RemArc (non-commercial). Each clip's source, author and licence are stored with the asset and shown in the project page and `mix_report.json`. If nothing suitable is found the cue is left silent with a warning; swap in another candidate from the project page.

## Security

- Dashboard behind a password session (signed, HTTP-only cookie). Bot and worker use bearer tokens stored as SHA-256 hashes; bootstrap env tokens are optional.
- Each task's uploads are limited to its own asset keys, MIME types and size caps (images 25 MB, thumbnail JPEG 2 MB, video 8 GB, and so on). Images are decoded with sharp before they are accepted.
- Downloads are presigned and expire (`SIGNED_URL_TTL_SEC`, default 6 h).
- Per-token and per-IP rate limits (in memory per Vercel instance; caps bursts, not a global quota).
- Every ffmpeg/ffprobe/node call uses argument arrays; long filter graphs go through files. No shell strings.
- Secrets are never logged; the worker reports only whether each key is set.

## Known gaps

- Background music (`audio.music`) is accepted in the schema but not mixed yet.
- Rate limiting is per serverless instance.
- Captions are burned in only when `render.burn_in_captions` is true; YouTube captions are not uploaded (the SRT is stored with the project).
