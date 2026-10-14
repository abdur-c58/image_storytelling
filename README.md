# Slideshow Storytelling

Paste a story bible once, then one episode JSON per video, and get a finished YouTube video: AI images (Google Flow, via the Grok bot) kept consistent by approved location and character masters, Fish Audio narration with voice tags, licensed sound effects, Remotion cards and thumbnail, a loudness-checked mix, a sentence-driven crop render, and an upload to YouTube Studio (also via the bot).

Documents use schema **2.3** (`story_bible`, `episode`, or a `bundle` of both); 2.0–2.2 documents are still accepted. What changed from 1.0, in 2.1 (dialogue, recurring cast, character status), 2.2 (viewer identification, name cards, segment roles) and 2.3 (story folders, episode header, versions), is in `docs/SCHEMA_V2_CHANGELOG.md`.

```text
             paste JSON                               poll over HTTPS (outbound only)
  you ──────────────────▶  Website (Next.js, Vercel)  ◀──────────────────────────┐
                            │  Supabase Postgres: projects, tasks, assets       │
                            │  R2: slideshow-storytelling/…  (presigned URLs)   │
                            ▼                                                   │
                   task queue with leases                                       │
                 ┌──────────┴───────────┐                                       │
        Grok bot (browser)              Worker (GPU PC, Python)  ─────────────────┘
   generate_location_master         voice · align · sfx · cards · thumbnail · mix · render
   generate_images (Google Flow)    imports the existing server's Fish/Whisper/ffmpeg code
   upload_youtube (Studio)
```

Nothing calls into the bot or the worker; both poll the site, so the PC needs no tunnel or open port.

## Story folders

Every story is a folder: **Stories › The Rising › Ep 1: Day 1**. The left sidebar lists stories and their episodes with a status dot (draft, in progress, awaiting bot, ready, published, failed); it can be collapsed and remembers which stories are open.

- **`/stories`**: every story with its episode count (of `total_episodes_planned`), a status roll-up, last activity and the latest thumbnail as a cover. Search, grid/list, **Show archived**, **Trash**, and **New story** (a name and an editable id; the folder starts empty).
- **`/stories/{id}`**: three tabs. **Episodes**: the numbered list (status, runtime, version, YouTube link, gap markers, "needs revalidation" flags), **Add episode** (paste or drop; disabled with "Add the story bible first" until the folder has a bible) and the "Context for episode N" block for Claude. **Story bible**: cast, location state history, masters, story state (copy/download), the bible JSON and the log. **Settings**: rename (the id never changes), description, default overrides, archive, move to trash.
- **`/stories/{id}/episodes/{n}`**: the episode page (pipeline, outputs, segments, log) with a version switcher, **Set active**, **Duplicate as new version**, **Download JSON**, and downloads for the MP4, thumbnail and description.
- **`/new`** stays a global paste box: every document files itself by `story_id` and `episode_number`, after a confirmation ("This will add Episode 3 'The Knock' to The Rising"). Dropping files on `/stories` or a story's Episodes tab does the same. Inside a folder, files for another story are refused.

**Versions.** Pasting an episode number that already exists stores **version 2** (then 3, …) after a confirmation that shows what changed. Exactly one version is active; the others are kept, stopped and viewable. Nothing is overwritten.

**Continuity across episodes.** Each episode's end state is stored as a snapshot once it validates. Episode N is validated against the snapshot of episode N−1 (or the bible's starting state), so episode 2 can be added while episode 1 is still rendering. When an earlier episode gets a new active version or is deleted, later episodes are re-checked in order: they are never deleted, and those that now fail are flagged "needs revalidation" with the errors. A skipped number is allowed with a warning.

**Trash.** Moving a story to the trash needs its name typed, stops its episodes and cancels its queued bot and worker tasks. It can be restored for 30 days; the daily cron then deletes it with all files.

**Files** are stored per folder: `stories/{id}/ep{NN}/v{V}/…` for episode outputs and `stories/{id}/masters/…` for masters. Bot and worker tasks carry `story_id`, `story_title`, `episode_number`, `episode_title`, `version` and `output_basename` (e.g. `the-rising-ep03-v2-the-knock`), which also name the downloads and the worker's work folders.

## Stories

A **story** holds the story bible: characters with outfits, locations with states, camera angles and props, world variables (day, weather, supplies), style and voice/crop defaults. Its own states:

| Story state | Meaning |
|---|---|
| `NO_BIBLE` | Empty folder made with **New story**; paste the bible next. |
| `STORY_VALIDATED` | Bible stored. |
| `LOCATION_MASTERS_REQUESTED` | The bot is making masters: an empty plate of every location × state × angle, a sheet of every character × outfit, and one picture of every character group. |
| `MASTERS_REVIEW` | Masters uploaded; approve or regenerate them on the Story page (prompts and "must match" landmarks are shown). |
| `MASTERS_APPROVED` | All approved. Episodes waiting on them continue. |

Episodes are validated against the story's **state**: locations change state only through `state_changes`, world variables stay consistent, characters appear from their first episode. The state after each episode comes from its active version's snapshot (see above); the story's Bible tab shows and exports it, and the Episodes tab gives the "Context for episode N" block for Claude. New things an episode introduces (`bible_additions`) are merged into the story and get masters too. With `automation.approval_gates.location_masters: false` there are no masters and nothing waits.

The story state also tracks each character's **status** (with you, separated, missing, captive, returned, unknown, deceased), changed by an episode's `character_status_changes`. Absent characters can only appear in flashbacks, over radio or phone, or in written notes. The Story page's **Cast** panel shows each character's status, scope and voice. Use **Test voice** there to hear a short sample in that voice (a `voice_sample` worker task), and **Add to channel cast** to make a character recurring.

**Voice ids without editing JSON or env.** Settings → **Voices** holds a default voice id (used by the narrator and any speaker without one) and a voice id per channel character (used in every story). Each row of the Story page's Cast panel also has a voice id field for that story only. Priority: Story page, then Settings channel voice, then the story JSON, then the Settings default, then the worker's `FISH_VOICE_ID`. The ids are applied when a voice task or voice test is handed to the worker, so a change takes effect on the next voice task. To hear it in an existing episode, regenerate that episode's voice.

**Channel cast.** Characters with `scope: "channel"` are stored in a channel-wide registry (`channel_characters`) the first time a story uses them. Later stories write `{ "ref": "mara" }` instead of redefining them. Their description, voice and reference images come from the registry, and their approved masters are copied in, so the face and voice stay the same across stories. Changing a channel character from another story is rejected with a list of the differences.

## Pipeline

| State | What happens | Who |
|---|---|---|
| `DRAFT` | Saved, not started (`automation.auto_start_on_submit: false`). | – |
| `VALIDATED` | Accepted; tasks are queued. | site |
| `WAITING_MASTERS` | Voice, sound and cards run; episode pictures wait until the masters they use are approved. | you |
| `GENERATING` | In parallel: `generate_images` (approved masters attached as references), `voice` → `align`, `sfx`, `cards`. Images are retried per item; only missing ones are asked for again. | bot, worker |
| `MIX` | Voice stem → −16 LUFS, SFX placed (beds looped and ducked), master → −14 LUFS / −1.5 dBTP. Fails if more than ±1 LU off. Writes `mix_report.json`. | worker |
| `IMAGES_RECEIVED` / `THUMBNAIL` | Thumbnail base generated, text composed (runs alongside the mix). | bot, worker |
| `RENDER` | Crop-plan clips (sub-pixel windows from the full-resolution source), transitions, NVENC (or libx264) encode, ffprobe check, preview copy. | worker |
| `REVIEW` | Waiting at an approval gate (`before_render` or `before_publish`), if enabled. | you |
| `PUBLISH_REQUESTED` → `PUBLISHED` | Bot uploads with the exact title/description/visibility and reports the URL. | bot |
| `FAILED` | A task hit its retry limit. Fix, then **Retry** in the project page. | – |

After `align`, the site splits each segment's narration into sentences, times them with Whisper's words and writes a **crop plan** into `timeline.json`: one-sentence segments stay full frame, two-sentence segments crop on the second, longer ones alternate full frame and a held crop (typically 4–10%, never over 20%), with moves placed in the gaps between sentences. The project page shows each plan on a mini timeline with a per-segment **Auto / On / Off** toggle and **Re-roll**; both redo only the render. Plans are seeded, so re-renders are identical unless re-rolled.

Voice: `narration` is clean text; `tts_text` carries Fish Drama 3 tags (`[pause]`, `<whisper>…</whisper>`). Whisper QA flags a segment where a tag was read aloud; the second time it switches that segment to **split and silence** (spoken in pieces cut at pause tags and sentence ends, joined with exact silences).

Dialogue: a segment can have `lines[]` (narrator and characters) instead of `narration`. Each line is spoken in its speaker's Fish voice, normalised to the voice target plus the speaker's `gain_db`, passed through its `voice_effect` (radio, phone, muffled, echo, memory; ffmpeg chains in the worker's `voice_effects.json`) and normalised again. Lines are joined with 350 ms gaps between narrator and dialogue and 220 ms between characters. The voice file is still one per segment, and the worker reports where each line starts and ends. The project page shows each line with a speaker chip, its effect and its own player. Crops prefer to start and end on a speaker change and lean toward the on-screen speaker.

To start episodes without the editor, drop one or more story bible, episode or bundle JSON files onto **Stories** or a story's Episodes tab (or use **Choose files** / **Paste JSON**). Each file is shown with what it will do (new story, new episode, or new version with a diff) and its warnings. Story bibles are saved first. A dialog asks how automation should run: **Run to YouTube** (no stops), **Review before publishing** (waits for your approval before upload), **Import only** (draft), or **Use each file's own settings**. Invalid files are listed with their errors and a **Fix in editor** button.

Stages run as soon as their inputs exist, so several can be active at once; the badge shows the furthest one. Every step is resumable: tasks are leased with heartbeats; a crashed agent's lease expires and the task is retried with backoff, then dead-lettered. Outputs are content-addressed (sha256), so re-runs skip work that already exists. The project page can regenerate one image, one voice line, the thumbnail, re-roll crops, or swap an SFX choice, and only the affected downstream stages re-run. Each picture has a prompt inspector showing the pieces its prompt was assembled from (style, location anchor, state, angle, world, characters, scene) and the masters sent as references.

## Repository layout

| Path | What |
|---|---|
| `app/`, `lib/`, `proxy.ts` | Website: dashboard, story/episode editor with live validation, Story pages, bot console (`/bot`), bot/worker APIs. |
| `lib/episode/` | Zod schemas (source of truth), validator with line/column errors, continuity checks, Fish tag grammar, sentence splitter, prompt assembly, v1→v2 converter. JSON Schemas exported to `schema/` (`npm run schema:export`). |
| `lib/crop/` | Crop engine: seeded PRNG, sentence timing, crop planning (property-tested). |
| `lib/pipeline/` | State machine (`advance.ts`), stories and masters (`story.ts`), crop planning (`crop.ts`), task payloads, completion handling, description/chapters/credits. |
| `drizzle/` | SQL migrations. |
| `../story-telling-worker/` | Not in this repo. Python worker (`python -m slideshow_worker`) and its `remotion/` project (card templates, icons, thumbnail composition). Runs on the GPU PC; never deployed to Vercel. |
| `bot/RUNBOOK.md` | Instructions for the Grok bot (served at `/api/bot/runbook`). |
| `scripts/fake-bot.ts` | Stand-in bot for testing (placeholder images, fake YouTube URL). |
| `scripts/e2e-dry-run.ts` | Full end-to-end test. |
| `scripts/migrate-v23.ts` | Optional: moves files stored before story folders into the folder layout. |
| `fixtures/` | `story_bible_example.json` with `episode_1.json` and `episode_2.json` (one story, two episodes), `episode_minimal.json`, `episode_full.json`, and `story_bible_second.json` with `episode_second_story_1.json` (a second, independent story); the 1.0 examples are in `fixtures/v1/`. |
| `docs/` | `CLAUDE_SCRIPT_CONTRACT.md` (give this to Claude when writing stories and episodes), `SCHEMA_V2_CHANGELOG.md`, `EXISTING_SERVER_AUDIT.md`. |

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

Starts a throwaway site, the fake bot and the worker with `DRY_RUN=1`, posts `fixtures/story_bible_example.json` + `fixtures/episode_minimal.json` as a bundle, approves the masters through the admin API when they arrive, runs to `PUBLISHED`, and checks the final MP4 with ffprobe (H.264 1920×1080 + AAC), that a crop plan was written, that the story state was committed, that the story folder pages render, and that the final video sits under `stories/rooftop-test/ep01/v1/`. Takes about a minute. `npm run e2e -- fixtures/episode_full.json --all-features` runs the full example (state changes, bible additions, reuse, cards) with burned-in captions and an outro; `--no-masters` switches the masters gate off. Render/publish gates are switched off for the run. Output stays in `.data/e2e-<timestamp>/`. To watch it in the browser instead, run `npm run dev` with `DRY_RUN=1`, then in two more terminals:

```powershell
$env:BOT_TOKEN="<bot token>"; npm run fake-bot
$env:WORKER_TOKEN="<worker token>"; $env:DRY_RUN="1"; npm run worker
```

### Tests

```powershell
npm test               # schemas, validator, continuity, crop property tests, queue/state machine on in-memory Postgres
npm run test:worker    # timeline, captions, WER, SFX licence filter and ranking, crop windows, tag splitting
npm run typecheck
npm run e2e
```

## Upgrading to 2.3 (story folders)

Migration `drizzle/0005_story_folders.sql` (applied by `AUTO_MIGRATE=1` or `npm run db:migrate`) runs in one transaction:

- Every project becomes a version of an episode: projects with the same story and episode number become versions 1, 2, … in creation order. The newest one that wasn't archived is active; the others are stopped (archived) and their queued tasks cancelled.
- Projects without a story go to a new **Unsorted** story (`unsorted`), numbered 1, 2, … by creation date. Migrated episodes and versions are marked "migrated".
- Each project's `outputs.story_state_end` becomes its snapshot. Archived stories keep `status: archived`.
- `0006` drops the old `stories.archived` column.

Existing files keep working where they are (rows keep their storage keys). To move them into the folder layout, run `node --conditions=react-server --import tsx scripts/migrate-v23.ts` (lists what would move), then with `--apply` (copy, verify size, update rows) and optionally `--delete-old`.

**Rollback.** Back up the database first (Supabase: Database → Backups, or `pg_dump`). Before `--delete-old`, a code rollback only needs the database restored: the old files are still in place. The schema can't be rolled back by a down migration (drizzle has none); restore the backup and deploy the previous commit. Don't run `--delete-old` until the new version has run for a while.

## Production setup

1. **Supabase**: create a project. Use the *transaction pooler* connection string (port 6543) as `DATABASE_URL`. Either set `AUTO_MIGRATE=1` or run `npm run db:migrate` once against the *direct* connection string.
2. **R2**: reuse the existing bucket. Create an API token with Object Read & Write on that bucket. Everything goes under `slideshow-storytelling/`. Add a CORS rule so the bot console can upload from the browser:

   ```json
   [{ "AllowedOrigins": ["https://your-app.vercel.app"], "AllowedMethods": ["GET", "PUT", "HEAD"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```

3. **Vercel**: import the repo, set the variables from `.env.example` (`SESSION_SECRET`, `ADMIN_PASSWORD`, `APP_BASE_URL`, `CRON_SECRET`, database and R2). `vercel.json` schedules `/api/cron/maintenance` daily (expired leases, intermediate clean-up, purging stories that have been in the trash for 30 days).
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

## Crop rendering cost

`python tools/bench_crop.py` in the worker renders a 12 s segment at 1920×1080 / 30 fps from a 2560×1440 source, as a still and with a 4-move crop plan. On the dev PC (libx264 veryfast, noise image as worst case): still 6.05 s, crop plan 6.18 s, so about 2× realtime either way. Frames are sampled with Pillow's Lanczos from float boxes (no whole-pixel snapping), and held windows reuse the previous frame, so the crop path costs about the same as a still.

## Known gaps

- Background music (`audio.music`) is accepted in the schema but not mixed yet.
- Rate limiting is per serverless instance.
- Captions are burned in only when `render.burn_in_captions` is true; YouTube captions are not uploaded (the SRT is stored with the project).
- "Upscaling" narrow pictures is Lanczos resampling, not an AI upscaler; such pictures are flagged so you can regenerate them.
