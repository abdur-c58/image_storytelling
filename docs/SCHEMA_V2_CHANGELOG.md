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

---

# Schema 2.1 (dialogue, recurring cast, character status)

`schema_version` is now `"2.1"`. Documents marked `"2.0"` are still accepted (2.1 only adds optional fields); new and exported documents use `"2.1"`.

## 2.1-1. Story bible

| Field | Status | Notes |
|---|---|---|
| `narrator` | new | `{ pov, pov_character_id, voice }`. `pov`: `second_person` (default) \| `first_person` \| `third_person`. `voice`: `{ voice_id, model, speed, gain_db }`; empty fields fall back to `defaults.voice`. |
| `characters[].scope` | new | `"story"` (default) \| `"channel"`. |
| `characters[]` as `{ "ref": id, "story_outfit_states": [...] }` | new | Uses a channel character from the registry. Optional `first_appears_episode` and `initial_status` may be given with the ref. |
| `characters[].voice` | new | `{ provider, voice_id, model, speed, gain_db, style_notes, pronunciation_overrides }`, nullable. Needed to speak dialogue. |
| `characters[].voice_group` | new | Optional label. Two speakers with the same `voice_id` get a warning unless they share a `voice_group` (declared on purpose). |
| `characters[].initial_status` | new (my addition) | Status at the start of the story, default `with_protagonist`. The brief doesn't say where the first status comes from. |
| `character_groups[]` | new (my addition) | `{ id, character_ids (2+), description }`. Each group gets a `generate_character_group_master` reference picture. The brief asks for group masters but not how groups are declared. |
| `style_bible.multi_character_negative` | new | Negative-prompt line added when 2+ characters share a picture. Default: `merged faces, duplicate faces, fused bodies, extra limbs, the same face on two people, twins`. |
| `style_bible.flashback_treatment_prompt` | new (my addition) | Text appended for `visual_treatment: "flashback_tint"`. Default: `shown as a memory: faded warm sepia tint, soft hazy edges, gentle vignette`. |

## 2.1-2. Channel cast registry

New table `channel_characters` (`id`, `name`, `definition`, `reference_assets`, `origin_story_id`, `masters`, timestamps).

- A `scope: "channel"` character is added to the registry the first time a story using it is saved.
- Later stories reference it with `{ "ref": id }`. The site expands the ref from the registry before validating: `visual_description`, `reference_image_ids` (and the reference assets they point at) and `voice` come from the registry, and `story_outfit_states` are appended as story-only outfits.
- Re-defining a channel character in full with a different `visual_description`, references or voice is an error that lists each difference. Only new outfit states are allowed.
- A `story` character can be promoted to `channel` (Story page button). Re-pasting a bible may change `story` → `channel` but never the reverse.
- Approved character masters of a channel character are reused (copied) by later stories, so the same face carries across stories.

## 2.1-3. Segments: `lines[]`

| Field | Status | Notes |
|---|---|---|
| `segments[].lines` | new | Nullable. A segment has either `narration` (+ `tts_text`) **or** `lines`, not both. |
| `lines[].id` | new | Unique across the episode. |
| `lines[].speaker` | new | `"narrator"` or a character id with a `voice`. |
| `lines[].text` / `tts_text` | new | Same rules as `narration` / `tts_text` in 2.0. Quote marks in `text` are a warning. |
| `lines[].voice_effect` | new | `none` \| `radio` \| `phone` \| `muffled` \| `echo` \| `memory`. |
| `lines[].on_screen` | new | Default `true` for characters, ignored for the narrator. Biases crops toward the speaker. |
| `lines[].source` | new (my addition) | `"spoken"` (default) \| `"written"` (a note or message read aloud). `"written"` is the "off-screen note/message" exception from the brief, which had no field for it. |
| `lines[].caption_text` | new | Optional caption override per line. |
| `sentence_split_override` | restricted | Only allowed with `narration`, not with `lines`. |

The site normalises `narration` into one narrator line, so everything downstream reads `lines`. The resolved episode still fills `narration`/`tts_text` with the joined lines for the parts that only need the whole text: Whisper matching, captions, word-error rate.

## 2.1-4. Voice

| Field | Status | Notes |
|---|---|---|
| `voice.narrator_to_dialogue_gap_ms` | new | Default 350. Gap when the speaker changes between narrator and a character. |
| `voice.dialogue_reply_gap_ms` | new | Default 220. Gap between two different characters. Same speaker continuing uses `pause_between_sentences_ms`. |
| Trailing pause tag on a line | rule | Removed from the text sent to Fish, and its duration is **added** to the gap after the line. |

Each line is synthesised with its speaker's voice and normalised to `audio.voice_target_lufs + gain_db`. Then the effect chain is applied and the line is normalised again. Effect presets (ffmpeg filter chains) live in the worker's `voice_effects.json`, so you can tune them without touching the site. The voice stage still uploads one file per segment and reports each line's start and end inside it. Those line times go into `timeline.json` and drive per-line players and timing.

## 2.1-5. Character status (story state)

`story_state` snapshots gain `character_status: { [id]: { status, last_known_location_id, last_seen_episode, outfit_state_id } }`. Statuses: `with_protagonist`, `separated`, `missing`, `captive`, `returned`, `unknown`, `deceased`.

Episodes change a status with `character_status_changes: [{ character_id, to_status, at_segment_id, cause, story_override }]`.

- **Timing (my interpretation).** A change to an absent status (`separated`, `missing`, `captive`, `deceased`) takes effect **after** its segment, so that segment can still show the parting. Any other change takes effect **at** its segment, so the return can be shown.
- **Absent characters.** An absent character may not be in `characters_present`, or speak, in a `present` segment. The exceptions: a line with `voice_effect` `radio` or `phone`, a line with `source: "written"`, or a segment with `scene.timeframe` `flashback` or `imagined`.
- **`deceased`.** Can only change back with `story_override: true`.

## 2.1-6. Scenes

| Field | Status | Notes |
|---|---|---|
| `scene.timeframe` | new | `present` (default) \| `flashback` \| `imagined`. Non-present scenes skip location-state, world-variable, outfit and status persistence, and don't change the story state. |
| `scene.visual_treatment` | new | `flashback_tint` \| `none`. Defaults to `flashback_tint` for flashbacks and `none` otherwise. |
| `thumbnail.pairing_layout` | new | `side_by_side` \| `foreground_background` \| `split`, used when the thumbnail has 2+ characters. |

## 2.1-7. Prompts and masters

- Pictures with 2+ characters get an `Exactly N different people` part, each character's description, outfit and frame position, and `style_bible.multi_character_negative` added to the negative prompt.
- New bot task `generate_character_group_master` (one per batch of groups). Group masters appear in the same Story gallery, gate episode images the same way, and are sent as an extra reference whenever all of a group's members share a picture.

## 2.1-8. Crop engine

- Sentences are built line by line and carry `line_id`, `speaker` and `on_screen`. When line times are known, each line's sentences are timed inside that line's window.
- A speaker change is a preferred boundary: the crop start moves by up to one sentence to land on one, and so does the return to full frame.
- A crop that starts on an on-screen speaker's sentence is centred on that speaker with probability `focal_bias`. The point is a `focal_points` entry labelled with the character id, else the character's `position_in_frame` (left 0.3, center 0.5, right 0.7, background 0.5; y 0.45).
- All other limits are unchanged.

## 2.1 conflicts with the existing implementation, and how I resolved them

1. **Whisper "per line".** The worker runs Whisper once per episode, so the model loads only once. Per-line timing comes from the line windows the voice stage measured exactly (it builds the segment file itself). Words are assigned to lines by those windows, then aligned per line. The result is the same as running Whisper per line, without reloading the model for every line.
2. **One voice file per segment.** Mix, align, SFX and render all work per segment, so the voice stage still writes `voice/<segment>`. Line audio lives inside it, and the per-line player plays that file between the line's start and end.
3. **Loudness.** Lines are normalised one by one. The mix's voice-stem normalisation is linear (one gain for the whole stem), so the balance between speakers is kept. Clips under 1 second are measured with an RMS-based estimate, because the integrated LUFS measurement needs at least 400 ms blocks and is unreliable on short clips.
4. **Second-person visual rule.** As written, the brief warns when the POV character is **not** in `characters_present`. That fits a style where "you" are drawn in frame (as in the fixtures), so I implemented it as written. It is a warning, never an error.
5. **Narrator name lint.** A POV character named "You" (as in the example story) would trip on every line, so names that are pronouns (`you`, `your`, `yourself`) are skipped.
6. **Tag whitelist per model.** Character lines use the episode's `voice.tag_whitelist`, the same as the narrator. The bible has one whitelist and no per-model table yet.

# Schema 2.2: viewer identification and segment roles

`schema_version` "2.2". 2.0 and 2.1 documents are still accepted. Every new field has a default, so older documents parse unchanged. The new structure rules only run on 2.2 episodes, and the identification rules only run when the bible has a `narrator.identification` block.

## 2.2-1. Viewer identification (`story_bible.narrator.identification`)

```json
"identification": {
  "pov_character_id": "protagonist",
  "min_on_screen_ratio": 0.8,
  "hard_min_on_screen_ratio": 0.5,
  "forbid_narrator_name": true,
  "name_card": { "enabled": true, "episode": 1, "text": "THIS IS YOU", "template": "name_card" }
}
```

| Field | Default | Rule |
|---|---|---|
| `pov_character_id` | `narrator.pov_character_id` | Must be a known character. If both are set they must match (error). |
| `min_on_screen_ratio` | 0.8 | Below it is a warning. |
| `hard_min_on_screen_ratio` | 0.5 | Below it is an error. Must not exceed `min_on_screen_ratio`. |
| `forbid_narrator_name` | true | The narrator saying the POV character's name (or an alias) is an error; with `false`, a warning. |
| `name_card` | null | In episode `name_card.episode`, exactly one `title_card`/`infographic` with `remotion.template: "name_card"`: none is a warning, more than one is an error. |

- **On-screen ratio.** Counted over `illustration` and `reuse_image` segments whose scene has `timeframe: "present"`. A `reuse_image` without its own scene uses the scene of the segment it reuses (following chains). The ratio is the share of those segments whose `characters_present` includes the POV character. It is shown in the editor ("Viewer on screen", with a per-segment list) and on the project page (header and a chip per segment). With no eligible segments the ratio is empty and nothing is reported.
- **`scene.pov_exception_reason`** (new, up to 160 characters). It excludes a segment from the ratio, and the segment is still listed as "exception". If the POV character is in that picture anyway, you get a warning to remove the reason.
- **Narrator-name lint.** Applies to narrator lines only (plain `narration` counts as one narrator line). It matches the name plus `characters[].aliases` (new, default `[]`) as whole words, case-insensitive, and possessives like "Wick's" match. Names that are pronouns ("You") are skipped. Other speakers may say the name.
- **Without the block** the 2.1 behaviour is kept: a warning per present-day illustration missing the POV character (now skipped when `pov_exception_reason` is set) and a warning when the narrator names them. With the block, the ratio replaces the per-picture warning.
- **POV drift (2.2 episodes).** A narrator line saying "I/me/my" in a second-person story, or "you/your" in a first-person one, is a warning. This makes the contract's existing advice checkable.

## 2.2-2. Remotion template `name_card`

A still card at 1920×1080 with a dark background by default and `props.text` large in the centre. If an approved character master exists for `props.character_id`, it is shown as a small round icon above the text. `props.character_id` defaults to the POV character, and `props.text` defaults to `identification.name_card.text`; both are filled in when the episode is resolved. The card holds for `min_duration_sec` (default 2.0 s for name cards) and should be `silent: true` (otherwise you get a warning). The "card has no title" warning doesn't apply to it.

- Site: the `cards` task payload gains `portraits: { [segment_id]: { url } }`, taken from the approved `char/<id>/<outfit>` master (default outfit first).
- Worker: `card_props` passes `text` and `portraitUrl`; `Card.tsx` has a `NameCard` component.

## 2.2-3. Segment roles (`segment.role`)

`cold_open | recap | status_board | main | cliffhanger | end_card`, default `main`. All rules are warnings, prefixed "Structure:".

| Rule | Setting (default) |
|---|---|
| Episode 1 opens with `cold_open` | `cold_open_first` (true) |
| Episode 1 has no `recap` | always, when enabled |
| Episodes 2+: a `recap` in the first N segments | `recap_within_first` (3; 0 turns it off) |
| Total recap ≤ N seconds (estimated from words, like the runtime estimate) | `recap_max_sec` (15) |
| The recap keeps the narrator's point of view | always, when a recap exists |
| Exactly one `status_board` in the first N, and it is an `infographic` | `status_board_within_first` (5; 0 turns it off) |
| A `cliffhanger` in the last N unless `series.is_finale` (new, default false) | `cliffhanger_within_last` (3; 0 turns it off) |
| `end_card` is the last segment (and only the last) | `end_card_last` (true) |

Settings live in `story_bible.defaults.structure` and can be overridden per episode in `overrides.structure`. `enabled: false` turns every role check off.

- **Chapters.** When `youtube.chapters_from_segments` is true and the episode has **no** explicit `chapters`, chapters are built from runs of roles: Cold open, Previously, Status, the episode's short title for main runs ("… (part 2)" for later runs), Cliffhanger, Next time. Runs shorter than 10 s merge into the previous chapter (a short opening run merges into the next one), so YouTube's 10-second rule holds. Explicit `chapters` always win.
- **UI.** The editor has a "Structure check" panel (which roles are present, each rule with ✓ or !, and the role and estimated length of every segment), plus a new "Structure and identification" group in the issue lists. The project page shows a role chip on each non-main segment.

## 2.2 decisions and ambiguities

1. **Roles only on 2.2 episodes.** 2.0 and 2.1 episodes have no roles, so every segment would be `main` and fail the checks. Structure checks therefore run only when `schema_version` is "2.2".
2. **Identification is opt-in per story.** The rules apply only when the bible has `narrator.identification`, so existing stories keep their 2.1 warnings.
3. **Episode-1 cold open vs. status board.** Both are required early (cold open first, status board within the first 5). The full fixture opens with the "DAY 1" title card as the cold open, puts the status board fifth, and places the name card right after it.
4. **Recap length.** Estimated as words ÷ 2.4 wps plus the segment pause, like the runtime estimate, because real TTS lengths aren't known at validation time.
5. **Name card count** includes both `title_card` and `infographic` segments with the template. Cards in other episodes are allowed and aren't counted.
6. **The narrator-name rule is case-insensitive** and treats `'s` as outside the word, so "WICK'S" matches; "Wickham" doesn't.

# Schema 2.3: story folders and episode organisation

`schema_version` "2.3". 2.0–2.2 documents are still accepted. This release is mostly site organisation: a few header fields, new tables, and new pages. The render pipeline is unchanged.

## 2.3-1. Story bible

| Field | Rule |
|---|---|
| `story_id` | Unchanged: the folder's slug, immutable. |
| `story_title` | Display title. The folder can be renamed on the site; the stored title then wins over the bible's. |
| `story_description` | New, optional (default ""). Shown on the story page. |
| `total_episodes_planned` | Unchanged; now also "Episode N of M" in `{{series_nav}}` and "3 / 8 episodes" in the folder list. |

Re-pasting an identical bible is a no-op. Before a story has episodes the bible can change freely; afterwards only additions are accepted (as before).

## 2.3-2. Episode header

`story_id` (required, the story must exist), `story_title` (informational), `episode_number` (integer ≥ 1, required in 2.3), `episode_title` (required in 2.3), `is_finale` (optional), all at the top level.

- Older documents keep `episode_number`, `episode_title_short` and `is_finale` in `series`. Before parsing, each form is filled from the other (`lib/episode/header.ts`). If both are present and disagree, it is an error.
- `youtube.title` defaults to `episode_title`. `youtube.playlist` defaults to the story title.
- A `story_title` that differs from the stored title is a warning: "This episode's story_title 'The Rising' differs from the stored title 'Rising'. Using the stored title."
- A skipped number is a warning: "Episode 4 was added while Episode 3 is missing. State continuity is computed from Episode 2."
- New description placeholder `{{series_nav}}`: "Episode N of M" plus "Previous: …" / "Next: …" lines for neighbours that are already on YouTube. It is filled at render time and refreshed in the stored description of unpublished neighbours when an episode is published.
- 2.2 structure rules and POV-drift checks now apply to 2.2 **and later** episodes.

## 2.3-3. Versions and snapshots

- Re-pasting an existing `episode_number` stores a new version (v2, v3, …) after a confirmation with a diff summary. Exactly one version is active. Older versions are kept, stopped, and viewable. Version numbers are never reused, even after a delete.
- When an episode version validates, its end state is stored (`story_state_snapshots`). Episode N validates against N−1's snapshot (or the initial state).
- Replacing, re-activating or deleting an earlier episode re-checks every later episode's active version in order. Their snapshots are recomputed, failures are flagged "needs revalidation" with the errors, and nothing is deleted. Continuity errors name the previous episode, e.g. "Episode 3 uses location 'raft' in state 'launched', but the story state after Episode 2 is 'under_construction' and no state change is declared."

## 2.3-4. Database

| Table | Purpose |
|---|---|
| `stories` | Gains `description`, `status` (active / archived / deleted), `deleted_at`, `bible_version`, `defaults_override`. `bible`, `raw_json` and `story_state` are nullable (an empty folder). `archived` is replaced by `status`. |
| `episodes` (new) | One per story and number (unique). `active_version_id`, `version_counter`, `migrated`. |
| `projects` | Each row is one **episode version**: `episode_id`, `version` (unique per episode), `needs_revalidation`, `revalidation`, `migrated`. |
| `story_state_snapshots` (new) | One per version: the story state after that episode. |

`stories.story_state` is now a cache of the active versions' snapshots. Migration `0005` files existing projects into episodes and versions and puts projects without a story into **Unsorted** (`unsorted`). The README has the details and the rollback note.

## 2.3-5. Storage, tasks and logs

- New files: `stories/{id}/ep{NN}/v{V}/…` and `stories/{id}/masters/…`. Old keys stay valid. `scripts/migrate-v23.ts` moves them (dry run by default).
- Every bot and worker task carries `story_id`, `story_title`, `episode_number`, `episode_title`, `version` and `output_basename`. The worker uses them for work folders (`work/tasks/{story}/ep{NN}/v{V}/…`), log lines and the rendered file name. The fake bot logs them, and the RUNBOOK explains them (they are never metadata).

## 2.3 decisions and ambiguities

1. **Versions are `projects` rows**, not a separate `episode_versions` table. Every existing project page, task, asset and API keeps working; `episodes` points at the active one.
2. **A new version always becomes active**, and the previous active version is stopped (archived, queued tasks cancelled). A leased task (e.g. an upload in progress) is cancelled too; its lease is lost on the next call. Duplicating a version also makes the copy active, as a draft.
3. **Snapshots are rewritten on recompute even when the episode now fails**, so later episodes are checked against what is actually stored. The resolved `episode.start_state` of an existing version isn't changed.
4. **The stored story title wins** over the bible's `story_title` and an episode's `story_title`.
5. **`youtube.playlist` defaults to the story title** for documents stored from now on. Migrated projects keep what they had.
6. **`{{series_nav}}` never edits YouTube.** Only descriptions not yet uploaded are re-rendered.
7. **"Awaiting bot"** means a queued or running bot task (pictures, masters, upload), or `PUBLISH_REQUESTED` / `WAITING_MASTERS`. "Ready" means waiting at an approval gate (`REVIEW`).
8. **Migration edge case.** If every version of a migrated episode was archived, the newest one is still the active version, but it stays archived (stopped) until you press **Resume** on its episode page.
9. **Archive vs trash.** Archive only hides a story from the list. Trash stops it, and it is purged after 30 days.
