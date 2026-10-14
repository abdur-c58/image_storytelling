# Story and episode JSON contract (schema 2.2, for the script writer)

Give this file to Claude (or any writer) together with:

- the JSON Schemas in `schema/` (`story_bible.schema.json`, `episode.schema.json`, `bundle.schema.json`; also served at `/api/schema?type=story_bible|episode|bundle`),
- the examples in `fixtures/`: `story_bible_example.json`, `episode_minimal.json`, `episode_full.json` (every feature),
- for episode 2 onwards, the **"Context for episode N"** block from the site's Story page (story id, the story state the next episode starts from, previous episodes).

The site validates every field and checks **continuity** against the stored story. Errors block saving; warnings are shown but do not block. The editor at `/new` shows each problem with its line and column.

## Three documents

| `doc_type` | What it is | When |
|---|---|---|
| `story_bible` | Characters, places, world variables, art style, voice/crop defaults. | Once per story (re-paste to add things). |
| `episode` | One video: segments with scenes, thumbnail, YouTube metadata. Refers to the story by `story_id`. | Every episode. |
| `bundle` | `{ "schema_version": "2.2", "doc_type": "bundle", "story_bible": {...}, "episode": {...} }` | First episode of a new story, in one paste. |

Every document starts with `"schema_version": "2.2"` and its `doc_type`. 2.0 and 2.1 documents are still accepted (2.0 has no dialogue; neither has segment roles, so the structure check is skipped for them). A 1.0 episode is rejected; the editor's **Convert v1** button turns it into a bundle.

## Output rules

1. Output **one JSON object only**: no Markdown fences, no comments, no trailing commas.
2. Ids (`story_id`, character, location, state, angle, prop, variable, segment and sfx ids) use only letters, digits, `_` and `-`. Use `seg_001`, `seg_002`, … for segments and `seg_004_sfx_1` for cues; ids are unique within their list.
3. Segment `order` values are 1, 2, 3, … and are the play order.
4. Never put `<` or `>` in the YouTube title or description, and never `[` or `<` in `narration` or a line's `text`.
5. Unknown keys are kept but ignored; misspelt keys silently do nothing, so match the names below exactly.

---

## Story bible

```text
schema_version, doc_type, story_id, story_title, total_episodes_planned?, channel, narrator?, style_bible, characters[],
character_groups?, scene_bible { world_variables[], locations[] }, defaults? { voice, audio, render, crop_policy }, automation?
```

Once a story has episodes, a re-pasted bible may only **add** things (nothing removed), so old episodes stay valid.

### channel

- `channel_name`: the YouTube channel; the default for every episode's `youtube.channel_name`.
- `recurring_cameo`: `{ description, rule, min_segments_per_episode? }`, e.g. a small mascot hidden in the frame. Segments opt in with `scene.include_channel_cameo: true`; fewer than `min_segments_per_episode` gives a warning.

### narrator

`{ pov, pov_character_id?, voice?, identification? }`

- `pov`: `second_person` (default, "you"), `first_person` ("I") or `third_person`. The site warns when narration drifts: "I/me" in a second-person story, "you" in a first-person one, or the POV character's own name in the narration.
- `pov_character_id`: the character the narrator is (for `first_person` / `second_person`). In second person that character is expected in most pictures (warning only).
- `voice`: `{ voice_id, model, speed, gain_db }`; empty fields fall back to `defaults.voice`.
- `identification`: the viewer-identification rules for second-person stories (see **Viewer identification**).

### style_bible (drives every image)

- `global_style_prompt`: the art style only (medium, line weight, palette, mood words). Same text for the whole story.
- `negative_prompt`: things to avoid in every image (`text, watermark, photorealistic`).
- `aspect_ratio` `16:9`, `target_resolution` `1920x1080`, `palette_notes` (free text).
- `source_image_min_width` (default 2560): pictures narrower than this are upscaled and flagged, because crops zoom in. Under 1280 px is rejected.
- `multi_character_negative`: added to the negative prompt whenever 2+ characters share a picture (default: merged faces, duplicate faces, fused bodies, extra limbs, …).
- `flashback_treatment_prompt`: appended to flashback pictures (default: a faded sepia memory look).

### characters[]

`{ id, name, aliases?, role, scope?, visual_description, outfit_states[], first_appears_episode, voice?, voice_group?, initial_status? }`

- `role`: `protagonist`, `ally`, `antagonist`, `cameo` or `extra`.
- `aliases`: other names the character goes by (nicknames, surnames). The narrator-name rule checks them too.
- `visual_description`: **fixed** traits only (body, face, hair). One sentence.
- `outfit_states[]`: `{ id, description }`, e.g. `beanie`: "a mustard yellow beanie and a grey scarf". The first is the default. Scenes pick one with `outfit_state_id`.
- `first_appears_episode`: using a character earlier is an error (unless marked `cameo`).
- `voice`: `{ voice_id, model?, speed?, gain_db?, style_notes?, pronunciation_overrides? }`. **A character without a `voice` cannot speak lines.** Give each speaker a different `voice_id`; two speakers sharing one is a warning unless both have the same `voice_group` (a deliberate choice, e.g. twins).
- `initial_status`: where the character stands at the start of the story (default `with_protagonist`; see **Character status**).
- `scope`: `story` (default) or `channel`. A **channel** character is a recurring member of the channel's cast: the first story that uses it registers it, and later stories reuse its look, voice and approved masters.

**Using a channel character in another story.** Don't redefine it; reference it:

```json
{ "ref": "mara", "story_outfit_states": [{ "id": "parka", "description": "a red parka with the hood down" }], "first_appears_episode": 1 }
```

The site fills in the rest from the channel cast. `story_outfit_states` are extra outfits for this story only. A full definition whose description, references or voice differ from the channel cast is an error that lists the differences. A story character can be promoted to the channel from the Story page, never the other way round.

### character_groups[]

`{ id, character_ids[] (2+), description? }`: characters often drawn together (siblings, a couple). Each group gets its own reference picture of them side by side, used whenever all of them share a picture. Only add groups that really recur.

### scene_bible.world_variables[]

`{ id, type, initial, values?, prompt_template?, applies_to_location_tags?, monotonic?, max_step_per_segment? }`

- `type`: `integer`, `number`, `string` or `enum` (with `values`).
- `prompt_template`: e.g. `"Weather: {value}"`, added to the prompt of every scene that sets it.
- `applies_to_location_tags`: e.g. `["outdoor"]`. A scene in a location with a matching tag **must** set this variable in `world_state`.
- `monotonic` (`increasing` / `decreasing`) and `max_step_per_segment`: breaking them gives a warning (day 3 → day 2, or water jumping).

### scene_bible.locations[]

`{ id, name, tags[], anchor_description, fixed_landmarks[], camera_angles[], states[], key_props[] }`

- `anchor_description`: what the place is, in one sentence. Goes into every picture of it.
- `fixed_landmarks[]`: things that are always there and always in the same place ("a round grey water tank on steel legs"). The bot checks masters against these.
- `camera_angles[]`: `{ id, name, prompt }`. Short ids (`a`, `b`, `c`) are fine.
- `states[]`: `{ id, description, is_base?, derived_from? }`. Exactly one `is_base`. States are how the place changes over the story (`clear` → `barricaded`).
- `key_props[]`: `{ id, description, default_position }`. Scenes list the ones in view in `props_in_frame`.

**Masters.** For every location × state × camera angle, every character × outfit, and every character group, the bot makes one reference picture ("master"). You approve them on the Story page. Approved masters are attached to every episode picture of that place and those characters, which keeps the look consistent. A location with 3 states and 3 angles is 9 masters, so add states and angles deliberately.

### defaults

`voice`, `audio`, `render` and `crop_policy` blocks (see below); episodes override them field by field in `overrides`.

### automation

`approval_gates.location_masters` (default `true`): episode pictures wait until every master they use is approved. `false` skips masters entirely.

---

## Episode

```text
schema_version, doc_type, story_id, series, segments[], character_status_changes?, thumbnail, youtube, chapters?, overrides?, bible_additions?, automation?
```

### series

`episode_number`, `episode_title_short` (required), `recap_of_previous`, `cliffhanger`, `next_episode_teaser`, `state_carryover` (free-form notes; the real state is computed from scenes), `is_finale` (default `false`; a finale needs no cliffhanger).

### segments[]

| Field | Notes |
|---|---|
| `id`, `order`, `type` | `type` is `illustration`, `title_card`, `infographic` or `reuse_image`. |
| `role` | `cold_open`, `recap`, `status_board`, `main` (default), `cliffhanger` or `end_card`. See **Segment roles**. |
| `narration` | Clean text that is captioned and checked against what Whisper hears. **No tags.** Aim for 8–40 words; over 60 gives a warning. |
| `tts_text` | The narration with Fish voice tags (see **Voice direction**). With the tags removed it must equal `narration`. Expected on segments of 3+ sentences. |
| `lines[]` | Instead of `narration`: the segment as narrator and dialogue lines (see **Dialogue**). Use one or the other, never both. |
| `caption_text` | Optional caption override. |
| `delivery` | Optional acting note (≤120 chars), e.g. `"whispered, tense"`. |
| `sentence_split_override` | Optional `string[]` when the automatic sentence split is wrong; must join back to the narration. Not allowed with `lines`. |
| `silent` | `true` for cards with no voice. |
| `min_duration_sec` | Hold the picture at least this long. |
| `transition_out` | `cut` (default), `crossfade_150ms` or `fade_black`. |
| `scene` | Required on `illustration` (below). |
| `image` | Below. |
| `remotion` | Card definition for `title_card` / `infographic`. |
| `sfx[]` | Sound effect cues. |

You never write timestamps; the worker measures them.

### scene (where and when the picture happens)

| Field | Notes |
|---|---|
| `location_id`, `state_id`, `camera_angle_id` | Must exist in the story (or in this episode's `bible_additions`). The state must be the location's **current** state (see state changes). |
| `world_state` | `{ "day": 2, "weather": "rain" }`. Required for variables that apply to this location; keep them consistent with earlier segments and episodes. |
| `characters_present[]` | `{ character_id, outfit_state_id?, pose_or_action, position_in_frame, cameo? }`. `position_in_frame`: `left`, `center`, `right` or `background`. The character's look and outfit are added for you; don't repeat them. |
| `props_in_frame[]` | Prop ids of this location that are visible. |
| `state_changes[]` | `{ location_id, from_state_id, to_state_id, cause, persist }`. Something happens to a place: the door gets barricaded. `persist: true` carries the new state into later segments and episodes; `false` is a one-off. Later scenes of that location must use the new state. |
| `include_channel_cameo` | Puts the channel's recurring cameo in this picture. |
| `timeframe` | `present` (default), `flashback` or `imagined`. Flashback and imagined scenes may show absent or dead characters, other outfits and old location states, and change nothing in the story state. |
| `visual_treatment` | `flashback_tint` or `none`. Defaults to `flashback_tint` for flashbacks, `none` otherwise. |
| `pov_exception_reason` | Why the viewer's character is deliberately not in this present-day picture (?160 chars), e.g. "the door, seen from the stairwell". Leaves the segment out of the on-screen ratio. |

`reuse_image` segments inherit the scene of the segment they reuse.

With 2+ characters in a picture, the prompt names each one with their description, outfit and position, says how many different people there are, and adds the multi-character negative. Give each character a distinct `position_in_frame`.

### image

| Field | Notes |
|---|---|
| `prompt` | **Action and composition only**: who does what, key objects, framing. Location, state, angle, world, characters and style are added automatically. No text or lettering in the image. |
| `focal_points[]` | `{ label, x, y }` (0–1, top-left origin): where the eye should go. Crops lean towards these. |
| `crop_override` | `null`, `{ "enabled": false }` for a picture that must never be cropped, or a partial `crop_policy`. |
| `negative_prompt_extra` | Added to the style bible's negative prompt. |
| `reuse_from_segment_id` | For `type: "reuse_image"`: show an earlier picture again. |

The project page shows the assembled prompt piece by piece (prompt inspector).

### Crops (instead of v1 `motion`)

The renderer slowly crops into each picture and back out, driven by sentences:

- A segment with **one sentence never crops**. With **two sentences** it crops on the second.
- Longer segments: N full-frame sentences (usually 2, sometimes 1), then a crop held for a sentence, then back to full frame before the next crop.
- Moves happen in the gap between sentences, so a move never lands mid-word.
- Amounts: typically 4–10%, never more than 20%.

So the way you break narration into sentences decides the camera rhythm. In dialogue segments, a change of speaker is a preferred place for a crop to start or end, and a crop on an on-screen speaker's line leans toward that character (with probability `focal_bias`). Add a `focal_points` entry labelled with the character id to say exactly where their face is. Defaults come from `crop_policy`:

`enabled, max_crop (≤ 0.20), typical_max_crop, min_crop, prob_typical, crop_measure ("linear" | "area"), sentences_before_crop ({"2": 0.8, "1": 0.2}), hold_sentences, min_hold_sec, transition ("ease" | "cut"), transition_ms, easing, focal_bias, avoid_repeat_region, end_on_full_frame, seed_mode ("per_project" | "fixed"), seed`.

### bible_additions (new things in this episode)

`{ characters?, locations?, location_states?, camera_angles?, key_props?, outfit_states?, world_variables? }`. **Append-only**: new ids only (repeating an addition unchanged is fine; changing an existing item is an error). Examples: `location_states: [{ "location_id": "rooftop", "state": {...} }]`, `camera_angles: [{ "location_id": "rooftop", "angle": {...} }]`, `outfit_states: [{ "character_id": "protagonist", "outfit": {...} }]`. Accepted additions become part of the story, and their masters are made before this episode's pictures.

### overrides

`{ voice?, audio?, render?, crop_policy?, structure? }`: any subset of fields; everything else comes from the story's `defaults`.

### character_status_changes[] (who is where)

The story tracks each character's status: `with_protagonist`, `separated`, `missing`, `captive`, `returned`, `unknown` or `deceased`. The "Context for episode N" block lists the current statuses. Change one with:

`{ character_id, to_status, at_segment_id, cause, story_override? }`

- A change to an absent status (`separated`, `missing`, `captive`, `deceased`) applies **after** `at_segment_id`, so that segment can still show the parting. Any other change (a return) applies **at** that segment.
- An absent character can't be in `characters_present` or speak on screen in a `present` scene. The exceptions: a line over `radio` or `phone`, a `source: "written"` line (a note or message), or a `flashback` / `imagined` scene.
- `deceased` is final. Bringing someone back needs `story_override: true` and is still flagged.

---

## Viewer identification

In a second-person story the viewer **is** the POV character, so the pictures must keep showing them and the narrator must never call them by name.

```json
"narrator": {
  "pov": "second_person",
  "pov_character_id": "protagonist",
  "identification": {
    "pov_character_id": "protagonist",
    "min_on_screen_ratio": 0.8,
    "hard_min_on_screen_ratio": 0.5,
    "forbid_narrator_name": true,
    "name_card": { "enabled": true, "episode": 1, "text": "THIS IS YOU", "template": "name_card" }
  }
}
```

- **On screen.** Of the `present`-time `illustration` and `reuse_image` segments, at least `min_on_screen_ratio` (80%) should have the POV character in `characters_present` (warning below it), and at least `hard_min_on_screen_ratio` (50%) must (error below it). A `reuse_image` counts the scene it reuses. Flashbacks, imagined scenes and cards don't count.
- **Deliberate exceptions.** A shot that must leave them out (the door from the other side, a close-up of the radio) gets `scene.pov_exception_reason`. It is not counted, but it is listed in the editor. Don't use it to dodge the rule; if the character is in the picture, remove the reason.
- **Never name them.** The narrator must not say the POV character's `name` or any of its `aliases` (whole words, any case, including "Wick's"). It's an error unless `forbid_narrator_name` is `false`. Other characters may use the name in their lines; that's how the viewer learns it.
- **Stay in person.** No "I/me/my" from the narrator in a second-person story (and no "you" in a first-person one).

### How to open episode 1

1. **Cold open** (`role: "cold_open"`): the first segment. A hook: the "DAY 1" card, or one striking picture of "you" in the middle of something.
2. A few `main` segments that show "you" doing things, in frame, in the second person.
3. **Status board** (`role: "status_board"`): an `infographic` (usually `supplies_card`) within the first 5 segments, saying what "you" have.
4. **Name card**: once, early in the episode named in `name_card.episode`, a silent `title_card` with `remotion.template: "name_card"`. It tells the viewer which drawn character they are. One per episode at most (more is an error).

```json
{ "id": "seg_name_card", "order": 6, "role": "main", "type": "title_card", "narration": "", "silent": true,
  "remotion": { "template": "name_card", "props": { "text": "THIS IS YOU", "character_id": "protagonist" } } }
```

---

## Segment roles

Every segment has a `role` (default `main`). Required order:

| Role | Where | Rule (warnings) |
|---|---|---|
| `cold_open` | Episode 1, segment 1 | Episode 1 starts with it. |
| `recap` | Episodes 2+, within the first 3 segments | Not in episode 1. All recap segments together ? 15 s (about 30 words). Keeps the narrator's point of view. |
| `status_board` | Within the first 5 segments | Exactly one per episode, and it is an `infographic`. |
| `main` | Everything else | |
| `cliffhanger` | Within the last 3 segments | At least one, unless `series.is_finale` is `true`. |
| `end_card` | The last segment | Only the last segment. |

The limits are in `story_bible.defaults.structure` (`enabled`, `cold_open_first`, `recap_within_first`, `recap_max_sec`, `status_board_within_first`, `cliffhanger_within_last`, `end_card_last`) and can be changed per episode in `overrides.structure`. The editor's **Structure check** panel shows which roles are present and which rules pass.

Typical episode 2+: `recap` ? `status_board` ? `main` ? ? `cliffhanger` ? `end_card`.

---

## Dialogue (`lines[]`)

A segment can be told as lines instead of one narration. Each line is voiced with its speaker's voice.

| Field | Notes |
|---|---|
| `id` | Unique in the episode, e.g. `seg_004_l1`. |
| `speaker` | `narrator` or a character id that has a `voice`. |
| `text` | What is said and captioned. Same rules as `narration`: no tags, and **no quote marks** (warning). |
| `tts_text` | Optional, with voice tags. Tags removed, it must equal `text`. A pause tag at the very end becomes extra silence before the next line. |
| `voice_effect` | `none` (default), `radio`, `phone`, `muffled`, `echo` or `memory`. |
| `on_screen` | Default `true` for characters. `false` for a voice from off frame; the crop then doesn't lean toward them. |
| `source` | `spoken` (default) or `written` (a note or text message read aloud). |
| `caption_text` | Optional caption override. |

Gaps are automatic: 350 ms when the narrator hands over to a character or back (`narrator_to_dialogue_gap_ms`), 220 ms between two characters (`dialogue_reply_gap_ms`), the normal sentence pause when the same speaker continues. Every line is levelled to the same loudness, so don't use tags to make one voice louder.

```json
"lines": [
  { "id": "seg_006_l1", "speaker": "narrator", "text": "The radio crackled at midnight." },
  { "id": "seg_006_l2", "speaker": "mara", "text": "Anyone there? We have water.", "voice_effect": "radio", "on_screen": false },
  { "id": "seg_006_l3", "speaker": "protagonist", "tts_text": "<whisper>Don't answer.</whisper> [pause]", "text": "Don't answer." }
]
```

Keep dialogue short. One to three lines per character per segment reads best; long speeches belong to the narrator.

---

## Voice direction

`narration` is what the viewer reads and what Whisper checks. `tts_text` is the same words plus Fish Audio directions. The voice model is Fish **Drama 3** (`drama-3-preview`).

**Square-bracket cues** (one at a time, never nested):

| Cue | Use |
|---|---|
| `[short pause]`, `[pause]`, `[long pause]` | Beats. Default lengths 400 / 700 / 1200 ms. |
| `[break]`, `[long-break]` | Same idea, 400 / 1200 ms. |
| `[breath]`, `[sigh]`, `[laugh]`, `[shaky breath]` | Sounds. |
| `[any short direction]` | Free-form, e.g. `[barely holding it together]`; applies from that point. Allowed, but not on the whitelist, so it gives a warning. |

**Paired tags** for a few words: `<whisper>…</whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`, `<forceful>`. They must be closed, in reverse order of opening.

Rules:

- Strip every tag from `tts_text` and you must get `narration` back exactly (punctuation and capitals may differ). Never add, drop or reorder words in `tts_text`.
- At most **8 tags per 100 words** (`max_tags_per_100_words`). Fewer is better; let the punctuation carry most of the rhythm.
- Put pauses where a narrator would breathe: after a reveal, before a number, between the setup and the punchline.
- Sentences get a natural gap (`pause_between_sentences_ms`, 350); segments get `pause_between_segments_ms` (450).

**If Fish reads a tag aloud** ("pause" heard in the voice), the QA flags the segment. On the second time it switches that segment to `split_and_silence`: the text is cut at pause tags and sentence ends, each piece is spoken separately, and exact silences are inserted. Writing clean tags avoids this.

```json
"narration": "The water was gone. All five thousand gallons, in two days.",
"tts_text": "The water was gone. [long pause] <slow>All five thousand gallons</slow>, in two days."
```

---

## Cards, sound, thumbnail, YouTube

### remotion (cards)

`template`: `title_card`, `supplies_card`, `pictogram_chart`, `statement_card`, `lower_third`, `name_card`, `custom`.

`name_card` introduces the viewer's character: large centred `props.text` on a dark background, with the character's approved reference picture as a small round icon. `props.character_id` defaults to the POV character and `props.text` to `identification.name_card.text`. Make it a `silent` `title_card`; it holds for 2 s unless `min_duration_sec` says otherwise.

| Prop | Notes |
|---|---|
| `title`, `subtitle`, `body`, `footer` | Short text. Titles auto-shrink; keep them under ~24 characters. |
| `text`, `character_id` | `name_card` only. |
| `background` | `dark`, `cream` or `image` (with `background_image_segment_id`, or the segment's own `image.prompt`). |
| `accent` | `red` (default), `blue` or `none`. |
| `items[]` | For `supplies_card` and `pictogram_chart`: `{ label, value, icon, icon_count, icon_total }`, `icon_count ≤ icon_total`. Items at 25% or less are drawn red. |

Icons: `water_jug, can, gas_canister, zombie_head, radio, pigeon, kite, person, medkit, battery, flashlight, fire, rope, key, door, knife, bread, bottle, tent, sun, moon, skull, heart, house`. Any other name renders a lettered circle (warning).

### sfx[] (sound effect cues)

| Field | Notes |
|---|---|
| `id` | Unique, e.g. `seg_004_sfx_1`. |
| `search_query` | 2–4 plain words describing the **sound**: `door slam`, `wind howling`. |
| `alt_queries` | Fallback searches, broader each time. |
| `must_include_tags`, `exclude_tags` | e.g. exclude `music`, `voice`. |
| `placement` | `segment_start`, `segment_end`, `at_phrase` (with `at_phrase` copied word-for-word from the narration) or `whole_segment`. |
| `offset_sec`, `duration_sec`, `loop`, `continues_into_next` | Timing. `loop: true` for beds. |
| `gain_db` | Relative to the voice (default −18). Beds −20 to −26, impacts −10 to −16. |
| `fade_in_ms`, `fade_out_ms` | Defaults 100 / 300. |

Only commercially licensed clips are used (the channel is monetised): CC0, public domain, CC BY with credit, or the local licensed library. Non-commercial and Sampling+ licences are excluded. Unfindable cues are left silent with a warning.

### thumbnail

| Field | Notes |
|---|---|
| `image_prompt` | One strong subject, high contrast, empty space for text. **No text in the image.** |
| `scene` | Optional `{ location_id, state_id, camera_angle_id, world_state? }`: adds the location and its masters as references. |
| `characters_present` | Character ids. |
| `pairing_layout` | With 2+ characters: `side_by_side`, `foreground_background` or `split`. |
| `text_layers[]` | Up to 4: `{ text, style, position, max_font_size_px }`. Styles `impact_white_black_outline`, `impact_yellow_black_outline`, `red_badge`, `plain_white`. Avoid `bottom_right`. |
| `alt_variants` | 0–2 extra base images. |

### youtube

| Field | Notes |
|---|---|
| `channel_name` | Optional; defaults to the story's channel. The bot refuses a different channel. |
| `title` | ≤ 100 characters. |
| `description` | ≤ 5000 bytes after expansion. Put `{{chapters}}` and `{{sfx_credits}}` on their own lines. |
| `tags` | ≤ 500 characters total. |
| `category`, `language` | Default `Entertainment`, `en`. |
| `visibility` | `private`, `unlisted`, `public` or `scheduled` (with a future `scheduled_publish_at` including a timezone offset). |
| `playlist`, `pinned_comment`, `end_screen_note`, `comments_enabled` | Optional. |
| `made_for_kids` | Default `false`. |
| `contains_altered_or_synthetic_media` | Default `true` (AI images and voice). Leave it `true`. |

### chapters

`[{ "segment_id": "seg_005", "title": "Day 2" }]`. At least 3, the first at 0:00, each at least 10 s. Problems are fixed where possible or chapters are left out with a warning.

Leave `chapters` empty to get chapters from the segment roles instead: Cold open, Previously, Status, the episode's short title, Cliffhanger, Next time. Runs shorter than 10 s merge into the previous chapter.

### automation and render

- `automation.auto_start_on_submit` (default `true`), `approval_gates.before_render` / `before_publish`.
- `render` (via `overrides.render`): `fps`, `burn_in_captions` + `caption_style` (`bottom_bar`, `bold_center`), `intro_sec`, `outro_sec`, `crf`, `audio_bitrate_kbps`.

---

## Writing checklist

- [ ] `schema_version: "2.2"` and the right `doc_type`; the episode's `story_id` matches the story.
- [ ] Channel characters from earlier stories are `{ "ref": id }`, not redefined.
- [ ] Every speaker has a `voice`; speakers don't share a `voice_id` unless they share a `voice_group`.
- [ ] Narration matches the `narrator.pov` ("you" in second person, "I" in first person) and never says the POV character's name or aliases.
- [ ] The POV character is in at least 80% of present-day pictures; deliberate exceptions have `pov_exception_reason`.
- [ ] Every segment has a `role`: episode 1 opens with `cold_open`, episodes 2+ recap in the first 3, one `status_board` infographic in the first 5, a `cliffhanger` in the last 3, `end_card` last.
- [ ] Episode 1 (or the configured episode) has exactly one silent `name_card`.
- [ ] Absent or dead characters only appear in flashbacks, over radio/phone, or in written notes; status changes are in `character_status_changes`.
- [ ] Every `illustration` has a `scene` and an `image.prompt` (action only); every card has a `remotion` block.
- [ ] Scene states follow the story: a location's state only changes through a `state_changes` entry.
- [ ] `world_state` is set for every variable that applies to the location, and it never goes backwards.
- [ ] No character appears before their `first_appears_episode`; outfits exist.
- [ ] Anything new is in `bible_additions`.
- [ ] `tts_text` minus its tags equals `narration` (or the line's `text`); at most 8 tags per 100 words; no quote marks in lines.
- [ ] Sentence breaks are where the camera should move; one-sentence segments stay full frame.
- [ ] `at_phrase` text appears word-for-word in the narration; no text requested inside any image.
- [ ] The description contains `{{chapters}}` and `{{sfx_credits}}`.
