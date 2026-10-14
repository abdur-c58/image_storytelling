# Schema v2 changelog

`schema_version` goes from `"1.0"` to `"2.0"`. Every pasted document now has a top-level `doc_type`: `story_bible`, `episode` or `bundle`. A v1 episode is rejected with a pointer to the converter (`npm run migrate:v1 -- file.json`, or the **Convert to v2** button on `/new`).

## 1. New document: `story_bible`

Pasted once per story and stored in the new `stories` table.

| Field | Status | Notes |
|---|---|---|
| `schema_version`, `doc_type: "story_bible"` | new | |
| `story_id` | new | Slug. Replaces v1 `series.series_id`; projects are grouped by it. |
| `story_title` | new | Replaces v1 `series.series_title`. |
| `total_episodes_planned` | moved | From v1 `series`. |
| `channel.channel_name` | new | Default for `episode.youtube.channel_name`. |
| `channel.recurring_cameo` | new | `{ description, rule, min_segments_per_episode? }`. `min_segments_per_episode` is an addition: the free-text `rule` can't be checked, the number can. |
| `style_bible.global_style_prompt`, `negative_prompt`, `aspect_ratio`, `target_resolution`, `palette_notes` | moved | From v1 `episode.style_bible`. |
| `style_bible.source_image_min_width` | new | Default 2560. Narrower uploads are accepted but flagged and upscaled before rendering; under 1280 is rejected (unchanged). |
| `style_bible.characters`, `style_bible.reference_assets` | removed | Characters move to top-level `characters`; reference images are replaced by approved masters. |
| `characters[]` | moved + extended | v1 `{ id, name, visual_description, reference_image_ids }` plus `role`, `outfit_states[]`, `first_appears_episode`. `reference_image_ids` is kept but no longer resolved (no `reference_assets`). |
| `scene_bible.world_variables[]` | new | `{ id, type, initial, values? (enum), prompt_template, applies_to_location_tags, monotonic?, max_step_per_segment? }`. |
| `scene_bible.locations[]` | new | `{ id, name, tags, anchor_description, fixed_landmarks, camera_angles[], states[], key_props[] }`. |
| `defaults.voice`, `defaults.audio`, `defaults.render`, `defaults.crop_policy` | new | Same shapes as the episode blocks; episodes override them field by field. |
| `automation.approval_gates.location_masters` | new | Default `true`. |
| `automation.bot_triggers[]` | new | Only `location_masters` (task `generate_location_master`, `fire_when: "STORY_VALIDATED"`) is used. |

## 2. Changed document: `episode`

| Field | Status | Notes |
|---|---|---|
| `doc_type: "episode"`, `story_id` | new | `story_id` must match a stored story. |
| `series` | changed | Keeps `episode_number`, `episode_title_short`, `recap_of_previous`, `cliffhanger`, `next_episode_teaser`, `state_carryover` (now optional free-form notes). **Removed:** `series_id`, `series_title`, `total_episodes_planned` (they come from the story). |
| `style_bible` | removed | Inherited from the story. |
| `voice`, `audio`, `render` | removed | Inherited from `story.defaults`; override in `overrides`. |
| `overrides` | new | `{ voice?, audio?, render?, crop_policy? }`, merged field by field over the story defaults. |
| `bible_additions` | new | Append-only: `{ characters?, locations?, location_states?, camera_angles?, key_props?, outfit_states?, world_variables? }` (section 6). |
| `youtube.channel_name` | changed | Optional; defaults to `story.channel.channel_name` (warning if it differs). |
| `thumbnail.scene` | new | Optional `{ location_id, state_id, camera_angle_id, world_state?, characters_present? }` so thumbnails get location text and master references. |
| `automation` | unchanged | `before_render`, `before_publish`, `bot_triggers` behave as before. |

### Segments

| Field | Status | Notes |
|---|---|---|
| `scene` | new | Required on `illustration`. On `reuse_image` it is optional (inherited from the source segment); if given it must match the source's location, state and angle (warning). Not allowed on cards. |
| `scene.location_id`, `state_id`, `camera_angle_id` | new | |
| `scene.world_state` | new | `{ variable_id: value }`, required for variables whose `applies_to_location_tags` overlap the location's tags. |
| `scene.characters_present[]` | new | `{ character_id, outfit_state_id, pose_or_action, position_in_frame, cameo? }`. Replaces v1 `image.characters_present`. |
| `scene.props_in_frame[]` | new | Prop ids of that location. |
| `scene.state_changes[]` | new | `{ location_id, from_state_id, to_state_id, cause, persist }`. |
| `scene.include_channel_cameo` | new | My addition; adds the channel cameo to the prompt and counts toward `min_segments_per_episode`. |
| `image.prompt` | changed meaning | Action and composition only; location and characters are injected. |
| `image.focal_points[]` | new | `{ label, x, y }`, 0–1. |
| `image.crop_override` | new | `null`, `{ enabled: false }`, or a partial `crop_policy`. |
| `image.motion` | **removed** | Replaced by the crop engine; a leftover `motion` gives a warning and is ignored. |
| `image.characters_present`, `shot_type`, `mood`, `time_of_day` | **removed** | Replaced by `scene` (characters, camera angle) and the location state. Leftovers give a warning and are ignored. |
| `image.negative_prompt_extra`, `image.reuse_from_segment_id` | unchanged | |
| `narration` | stricter | Clean text: any `[` or `<` is an error. |
| `tts_text` | changed meaning | The narration plus Fish tags; expected on most spoken segments (warning if missing on segments of 3+ sentences). |
| `sentence_split_override` | new | `string[]`; must join back to the narration. |
| `delivery` | unchanged | Still prepended as a `[direction]` cue for `drama*`/`s2*` models. |

## 3. `voice` (story default, episode override)

| Field | Status | Notes |
|---|---|---|
| `tag_whitelist` | new | Defaults from Fish's Drama 3 docs (section 7). |
| `paired_tags` | new | My addition: `whisper, emphasis, soft, fast, slow, stress, forceful`. |
| `unknown_tag_level` | new | `"warning"` (default) or `"error"`. |
| `max_tags_per_100_words` | new | Default 8. |
| `pause_between_sentences_ms` | new | Default 350. Only enforced in `split_and_silence` mode (see conflict 6). |
| `pause_between_segments_ms` | default changed | 250 → 450. |
| `tag_fallback_mode` | new | `"split_and_silence"` (default) or `"none"`. |
| `pause_durations_ms` | new | `{ "short pause": 400, "pause": 700, "long pause": 1200, "break": 400, "long-break": 1200 }`, configurable. |

## 4. `crop_policy` (new; story default, episode override, segment `image.crop_override`)

`enabled, max_crop (hard cap 0.20), typical_max_crop, min_crop, prob_typical, crop_measure ("linear" | "area"), sentences_before_crop, hold_sentences, min_hold_sec, transition ("ease" | "cut"), transition_ms, easing, focal_bias, avoid_repeat_region, end_on_full_frame, seed_mode ("per_project" | "fixed"), seed`. `seed` is my addition, used when `seed_mode` is `"fixed"`.

## 5. `timeline.json`

Each segment gains `sentences: [{ index, text, start_sec, end_sec }]`, `crop_plan: [...]` and `crop_seed`. `motion` is removed. `crop_plan[].at_sec` is when the transition **starts**; it ends at `at_sec + transition_ms / 1000`.

## 6. `bible_additions` rules

New items only: an id that already exists in the story with a different definition is an error. Repeating an addition unchanged is allowed, so an episode can be re-imported after its additions were merged. New states may be added to existing locations (`location_states: [{ location_id, state }]`), and the same goes for angles, props and outfit states. Additions are merged into the stored story when the episode project is created; only the new items get masters, and the episode's pictures wait for them like any other master.

## 7. Fish Audio tags (checked against the Drama 3 docs on 2026-10-14)

The configured model is `drama-3-preview` (the server's `FISH_TTS_MODEL`).

- Square-bracket cues are **free-form natural language** (`[sigh]`, `[short pause]`, `[barely holding it together]`); Fish documents no closed list. The default whitelist holds the documented sounds and pauses: `short pause`, `pause`, `long pause`, `break`, `long-break`, `breath`, `sigh`, `laugh`, `shaky breath`.
- Word-level delivery uses **paired angle tags**: `<whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`, `<forceful>`.

## Conflicts with the existing implementation, and how I resolved them

1. **Fish tags aren't a closed set (brief section 3.3).** The brief says an unknown `[tag]` is an error. On Drama 3 any bracket text is a valid direction, so an error would reject legitimate scripts. An unknown bracket cue is a **warning by default** (`unknown_tag_level` switches it to an error). Unknown or unbalanced **paired** tags are errors, because that list is closed.
2. **Delivery tags use a different syntax.** The brief assumes `[whisper]`. Fish uses `<whisper>…</whisper>` for word-scoped delivery, and a bracket cue such as `[whispering]` for "from here on". Both are accepted in `tts_text` and both are stripped before comparing with `narration`.
3. **Tasks and assets belonged to projects only.** Location masters belong to a story. `tasks`, `assets` and `task_events` get a nullable `story_id`, and `project_id` becomes nullable; each row has exactly one of the two. Story files are stored under `slideshow-storytelling/stories/<story_id>/`.
4. **The worker reads one self-contained episode.** The site resolves story + episode into one **resolved episode** (still carrying `style_bible`, `voice`, `audio`, `render`, plus `crop_policy` and the story snapshot) and stores that on the project. The worker's input shape barely changes.
5. **Crop planning location.** It needs Whisper word times (worker) and a sentence splitter shared with the UI (site). The worker's `align` keeps producing word timings; the site then splits sentences, maps them to times and writes `sentences` + `crop_plan` into `timeline.json` (a new timeline version). Re-rolling or toggling crops redoes only that step and the render, not Whisper. The crop maths is TypeScript, tested with vitest property tests.
6. **`pause_between_sentences_ms` in model mode.** With Drama 3 synthesising a whole segment, the worker can't tell where one sentence ends in the audio without running ASR first. The minimum gap is enforced in `split_and_silence` mode, where the worker controls the silences. In normal mode the model's own pauses (and your `[pause]` tags) are kept.
7. **Number of masters per (location, state, angle).** Every combination that exists gets a master, so 3 states × 3 angles is 9 images for one location. That is what the brief asks for; it is listed here because it can be many bot images per story.
8. **When story_state advances.** "After each successful episode" is taken to mean **published**. Unpublished test runs can be committed manually with **Commit story state** on the project page. An episode validates against the state left by the highest committed episode before it, so re-pasting an older episode still validates correctly.
9. **Existing v1 projects** in the database keep working for viewing and deleting, and they render without crops. New v1 pastes are rejected with a convert option.
10. **`STORY_DRAFT`** is never stored: a story bible is only saved once it validates, so stories start at `STORY_VALIDATED`. I also added `MASTERS_REVIEW` (all masters generated, waiting for approval), which sits between the two states in the brief.
