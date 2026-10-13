# Existing Server Audit

Audited: `C:\Users\Abdur\Documents\Projects\Youtube\server` (git remote `github.com/abdur-c58/billions-web-app`, branch head `4017f5b`), 12 Oct 2026.

## 1. What it is

A **stock-B-roll documentary pipeline** ("Billions"). A Claude-written `script.json` (beats → segments with narration + B-roll search query) is turned into a long-form video: Fish Audio TTS → Whisper alignment → Pexels/Pixabay B-roll fetch + AI judging → Remotion overlay cards → ffmpeg export → R2 publish queue for an external bot.

It is **not** an image-slideshow pipeline, but most of the heavy machinery (TTS, Whisper, GPU ffmpeg, Remotion invocation, R2, publish manifest) is directly relevant.

### Layout

| Part | Tech | Notes |
|---|---|---|
| `app/`, `components/`, `lib/`, `hooks/` | Next.js **16.2.9**, React 19, Tailwind 4 | UI. Deployed to Vercel. Proxies most `/api/*` to the Python backend via `next.config.ts` rewrites (`BROLL_BACKEND_URL`). Owns R2 storage pages and the `/publish` page. |
| `viewer/backend/` | Python 3.12, stdlib `ThreadingHTTPServer` (`broll_viewer.py`, ~3,250 lines), port **8766** | All heavy work. File-based state per project in `viewer/backend/workspace/projects/<id>/` (JSON job files, no DB). Background threads: automation watchdog (30 s), export queue, R2 sync loops. |
| `remotion/` | Remotion 4.0.x, 2 compositions (`FactCard`, `TitleCard`) | Rendered as **MP4 clips** via `npm exec remotion render` subprocess; no `renderStill` usage. |
| `scripts/server.mjs` / `server.cmd` | Node | Starts backend + **Cloudflare quick tunnel** (`trycloudflare.com`, random URL each start, pasted manually into the UI's "Backend Connect"). |
| `scripts/youtube_transcript_pdf.py` | Python | Builds a PDF of transcript + one frame per picture change from a YouTube URL. Used to produce the zombie reference PDF in the repo root (39 pages, "Beanie Survives" channel). |

### Environment on this machine (verified)

| Item | Status |
|---|---|
| ffmpeg | 8.0 essentials (gyan.dev) on PATH |
| GPU | NVIDIA RTX 5070, torch 2.7.1+cu128, CUDA available |
| Whisper | `openai-whisper` installed (not faster-whisper / stable-ts) |
| Node | v24.18.0 |
| Remotion | `remotion/node_modules` installed |
| cloudflared | `~/.cloudflared/cloudflared.exe` present |
| Env keys present (`.env.local`, names only) | `FISH_API_KEY`, `FISH_VOICE_ID`, `FISH_TTS_MODEL`, `FISH_TTS_DIRECTION`, `FISH_TTS_SPEED`, `PEXELS_API_KEY(_2)`, `PIXABAY_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `BROLL_BACKEND_PORT` |

## 2. Reusable as-is (import, no changes)

All of these import cleanly from `viewer/backend` in ~0.2 s with no side effects (tested).

| Module / function | What it gives us | How the new pipeline uses it |
|---|---|---|
| `fish_audio_tts.synthesize_chunk(text, config)`, `FishTtsConfig`, `load_fish_config()` | Working Fish Audio call: `POST https://api.fish.audio/v1/tts`, `model` header (default `drama-3-preview`), `reference_id`, prosody speed/volume, `[direction]` emotion cues, good error parsing | One call **per segment**; build a per-episode `FishTtsConfig` with `dataclasses.replace` (voice id / speed from the episode JSON). |
| `script_format.build_tts_text` logic (`[direction] sentence` cues, per-segment `delivery`) | Proven Drama-3 direction format | Mirror the format for `tts_text` / `voice.style_notes`. |
| `segment_timestamps.transcribe_audio(path, model)` + `load_whisper_words`/`save_whisper_cache` | GPU Whisper with `word_timestamps=True`, progress hooks, JSON word cache | Word timestamps for `at_phrase` SFX cues and WER QA. |
| `segment_timestamps` token matching (`tokens_equivalent`, number-phrase parsing, `SPELLING_ALIASES`) | Robust script↔Whisper token matching incl. numbers ("5,000" vs "five thousand") | Phrase lookup and WER scoring. |
| `hardware_monitor.resolve_whisper_device()` | CUDA/CPU selection | As-is. |
| `export_video.detect_encoder / encoder_args / run_ffmpeg / probe_duration / probe_decoded_duration / add_faststart / safe_replace / _format_srt_timestamp` | NVENC/AMF/QSV detection with libx264 fallback, arg-array ffmpeg runner with cancel support, Windows file-lock-safe replace | Render stage and probing. |
| `remotion_render.py` patterns (props-file + subprocess, hash cache, UTF-8 env) | Proven Windows Remotion invocation | Copied pattern for `remotion still` in a **new** Remotion project. |
| `publish_queue._chapter_problem` rules (≥3 chapters, first at 0:00, each ≥10 s) | YouTube chapter validity | Same rules for `{{chapters}}`. |
| `lib/r2-client.ts`, `lib/publish-r2.ts` (signed GET URLs, 6 h TTL) | R2 client + presigned download pattern | Template for the new site's `Storage` R2 driver. |
| R2 account/bucket | Already provisioned | New site stores everything under `slideshow-storytelling/` (`STORAGE_PREFIX`), no collision with `Publish/`, `.project/`, `Exported Videos/`. |

## 3. Missing (must be built)

- **Episode JSON schema** (zod + JSON Schema export). The existing `script.json` format (beats/segments/`content`/`type`) is different and is kept untouched.
- **Image pipeline**: prompt assembly from a style bible, bot task queue, image upload/QA, still-image (not B-roll) rendering, `reuse_image`.
- **DB-backed job queue with leases/heartbeats** and a real state machine. The server uses per-project JSON job files + in-memory threads + a 30 s watchdog; works for one PC but has no lease semantics and no external worker/bot protocol.
- **Bot API** (`/api/bot/*`, bearer tokens, runbook). Today the bot reads the `/publish` HTML page and clicks "Mark published"; no task protocol, no image tasks.
- **Per-segment TTS + per-clip loudness normalisation.** Existing TTS synthesises the whole transcript in ~2,500-char chunks and concatenates; segment timing is then *recovered* by Whisper. Per-segment synthesis makes timing exact.
- **SFX**: nothing exists (no Freesound/Openverse/local library, no licence tracking, no credits).
- **Proper mixing**: existing mix is `volumedetect` mean-dB gain + `amix` of narration and one looped background bed. No LUFS (`loudnorm`), no true-peak limiting, no sidechain ducking, no `mix_report.json`.
- **Remotion card templates** for this format (`title_card`, `supplies_card`, `pictogram_chart`, `statement_card`, `lower_third`, `custom`), icon library, bundled fonts, `renderStill`, thumbnail composition.
- **Auth.** Neither the Next app nor the Python backend has any authentication (see risks).
- **Dry-run mode, fake bot, tests.** None exist in the server.

## 4. Risks

1. **No authentication on the existing backend.** Every `/api/*` route on port 8766 is open, and `server.mjs` exposes it publicly via a quick tunnel. Anyone with the tunnel URL can create/delete projects, trigger paid Fish Audio TTS, and start exports. The new worker will **not** need the tunnel at all (outbound polling only). Recommend adding a shared-secret header to the existing backend separately (out of scope; not changed).
2. **Vercel constraints for the new site.** No persistent disk (so no local SQLite file), ~4.5 MB request body limit on serverless functions, function time limits. Consequence: DB must be hosted (chosen: Supabase Postgres), and large files (images, MP4) must go **directly to R2 via presigned PUT URLs**, not through the Next.js function.
3. **Whisper is `openai-whisper`** (slower than faster-whisper, fine on the RTX 5070). Per-segment transcription would reload/re-run many times; plan is one pass over the concatenated voice track, then split words by known segment offsets.
4. **Fish Audio defaults.** Existing payload hard-codes `format: "mp3"`, 128 kbps, `normalize_loudness: true`. Acceptable as a source but we will request a higher bitrate (or WAV if confirmed in current docs) and re-normalise with `loudnorm` ourselves. Model `drama-3-preview` is a *preview* model name; verify it is still valid at build time.
5. **Coupling by import path.** The worker imports `viewer/backend` via `SERVER_DIR` on `sys.path`. Renames in the server would break the worker; mitigated by a thin adapter module (`slideshow_worker/legacy.py`) as the only import point, plus a startup self-check.
6. **Disk usage.** `viewer/backend/workspace` holds multi-GB B-roll caches; the new worker gets its own work dir with retention rules.
7. **Export path conventions** (`Documents/ExportedVids/<channel>/exported/`) are B-roll specific; the new pipeline writes to its own work dir and R2.

## 5. Decision: how the new system attaches to the server

- **New website** = the Next.js app in `slideshow_storytelling/` (already scaffolded, Next 16.4). Separate from Billions so nothing there changes.
- **New worker** = a **Python** process in `story-telling-worker/` (next to this repo, not inside it) that polls the website (outbound HTTPS only) and **imports** the server modules listed in section 2 through one adapter. Python matches the existing Whisper/torch/ffmpeg code.
- **New Remotion project** in `story-telling-worker/remotion/` for cards and thumbnails (stills), so the existing `FactCard`/`TitleCard` project is untouched.
- **Changes to the existing server: none.** If a change becomes necessary it will be the smallest possible and recorded here.

## 6. As built (update after implementation)

- **Hosting:** site on Vercel, Postgres on Supabase (Drizzle over postgres-js with `prepare: false` for the transaction pooler), files in the existing R2 bucket under `slideshow-storytelling/`. Large files go straight to R2 with presigned PUT/GET URLs; the site never proxies video bytes.
- **Server changes: still none.** The worker imports only what `story-telling-worker/slideshow_worker/legacy.py` lists (`fish_audio_tts`, `segment_timestamps`, `script_format`, `export_video`, `hardware_monitor`) and checks them at startup (`python -m slideshow_worker selfcheck`). It loads the server's `.env.local` into its own process environment (variables already set win); values are never logged, and the site only ever receives a set/not-set flag per key name.
- **Encoder:** the server's `detect_encoder` picks NVENC/AMF/QSV when ffmpeg lists them. The worker additionally test-encodes 5 frames once and falls back to libx264 if the listed GPU encoder doesn't work.
- **Whisper:** `transcribe_audio` loads the model on every call, so the worker transcribes the whole episode's narration once (segments joined with 0.8 s gaps) and splits the words back by offset.
- **Not reused:** the server's automation watchdog, JSON job files, Cloudflare tunnel and publish queue. The new site/worker/bot talk over outbound HTTPS polling only.
