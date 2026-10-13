# Episode JSON contract (for the script writer)

Give this file to Claude (or any writer) together with:

- the JSON Schema: `schema/episode.schema.json` (also served at `/api/schema`),
- one of the examples in `fixtures/` (`full_example.json` shows every feature),
- for episode 2 onwards, the **"Context for episode N"** block from the site's Series page (recap, cliffhanger, state carry-over, characters).

The site validates every field. Errors block the project; warnings are shown but do not block. The editor at `/new` shows each problem with its line and column.

## Output rules

1. Output **one JSON object only**: no Markdown fences, no comments, no trailing commas (the validator rejects both).
2. `"schema_version": "1.0"`.
3. Ids (`series_id`, segment ids, character ids, sfx ids, trigger ids) use only letters, digits, `_` and `-`. Use the `seg_001`, `seg_002`, … pattern for segments and `seg_004_sfx_1` for cues; ids must be unique across the whole episode.
4. Segment `order` values are 1, 2, 3, … and are the play order (array order does not matter).
5. Never put `<` or `>` in the YouTube title or description.
6. Unknown keys are kept but ignored, so extra notes do no harm; misspelt keys silently do nothing, so match the names below exactly.

## Top-level shape

```text
schema_version, series, style_bible, voice?, audio?, segments[], thumbnail, youtube, chapters?, automation?, render?
```

Fields marked `?` have sensible defaults and can be left out.

## series

| Field | Notes |
|---|---|
| `series_id` | Stable for the whole series, e.g. `zombie-outbreak`. Episodes are grouped by it. |
| `series_title`, `episode_number`, `episode_title_short` | Required. |
| `total_episodes_planned` | Optional. |
| `recap_of_previous`, `cliffhanger`, `next_episode_teaser` | Text; feeds the next episode's context block. |
| `state_carryover` | `{ day_counter_end, resources: {...}, characters_status: {...} }`. Free-form values; keep them consistent between episodes. |

## style_bible (drives every image)

Each image prompt is assembled as: `global_style_prompt` + one sentence per character present (`Name: visual_description`) + shot, mood and time of day + `Scene: <segment prompt>`. So:

- `global_style_prompt`: the art style only (medium, line weight, palette, mood words). Same text every episode of a series.
- `negative_prompt`: things to avoid in every image (`text, watermark, photorealistic`).
- `characters[]`: `{ id, name, visual_description, reference_image_ids? }`. Describe **fixed visual traits** (clothing, colours, hair, props) in one sentence. Don't repeat them in scene prompts; listing the id in `characters_present` adds them.
- `reference_assets[]`: `{ id, description, asset_url_or_path }`. Public https URLs are handed to the image bot for character consistency.

## voice and audio

- `voice.voice_id`: a Fish Audio voice id; empty uses the worker's default.
- `voice.model`: empty uses the worker default. `[direction]` cues (from `delivery`) are only sent to models whose name starts with `drama` or `s2`.
- `voice.speed` (0.5–2), `voice.pause_between_segments_ms` (default 250).
- `voice.pronunciation_overrides`: `{ "Ra's": "Raz" }`; applied to the spoken text only (captions keep the original spelling).
- `audio`: defaults are right for YouTube (`master_loudness_lufs` −14, `true_peak_db` −1.5, `voice_target_lufs` −16, `sfx_default_gain_db` −18). `audio.music` is accepted but **not implemented yet**.

## segments[]

| Field | Notes |
|---|---|
| `id`, `order`, `type` | `type` is `illustration`, `title_card`, `infographic` or `reuse_image`. |
| `narration` | What is spoken and captioned. Required unless `silent: true`. Aim for 8–40 words; over 60 gives a warning. Write numbers the way they should be read aloud only if Fish reads them wrongly; otherwise use normal text ("5,000 gallons"). |
| `tts_text` | Optional: spoken text if it must differ from the caption (e.g. phonetic spelling). |
| `caption_text` | Optional caption override. |
| `delivery` | Optional short acting note (≤120 chars), e.g. `"whispered, tense"`. |
| `silent` | `true` for cards with no voice. |
| `min_duration_sec` | Hold the picture at least this long. Silent segments default to 3 s, cards to 2.5 s. |
| `transition_out` | `cut` (default), `crossfade_150ms` or `fade_black`. |
| `image` | See below. |
| `remotion` | Card definition for `title_card` / `infographic`. |
| `sfx[]` | Sound effect cues. |

Timing: a spoken segment lasts its voice length plus the pause. You don't write timestamps; the worker measures them.

### image (illustration, reuse_image, image-backed cards)

| Field | Notes |
|---|---|
| `prompt` | The scene only: who is where doing what, key objects, composition. One or two sentences. No style words (the style bible adds them), no text or lettering in the image. |
| `characters_present` | Character ids in this picture. |
| `shot_type` | `wide`, `medium`, `close-up`, `top-down`, `over-the-shoulder`. |
| `mood`, `time_of_day` | Short words. |
| `negative_prompt_extra` | Added to the style bible's negative prompt. |
| `motion` | `none`, `slow_zoom_in`, `slow_zoom_out`, `pan_left`, `pan_right`. Vary it; `none` for very short segments. |
| `reuse_from_segment_id` | For `type: "reuse_image"`: show an earlier segment's picture again (must come earlier and have a picture). Use it to save generations when the narration continues over the same scene. |

### remotion (cards)

`template`: `title_card`, `supplies_card`, `pictogram_chart`, `statement_card`, `lower_third`, `custom`.

`props`:

| Prop | Notes |
|---|---|
| `title`, `subtitle`, `body`, `footer` | Short text. Titles are set in a condensed display font and auto-shrink; keep them under ~24 characters. |
| `background` | `dark`, `cream` or `image`. With `image`, either set `background_image_segment_id` to reuse an earlier picture, or give the segment its own `image.prompt`. |
| `accent` | `red` (default), `blue` or `none`. |
| `items[]` | For `supplies_card` and `pictogram_chart` (at least one item): `{ label, value, icon, icon_count, icon_total }`. `icon_count ≤ icon_total`. Items at 25% or less are drawn red (running low). |

Icons available: `water_jug, can, gas_canister, zombie_head, radio, pigeon, kite, person, medkit, battery, flashlight, fire, rope, key, door, knife, bread, bottle, tent, sun, moon, skull, heart, house`. Any other name renders a lettered circle (warning).

### sfx[] (sound effect cues)

| Field | Notes |
|---|---|
| `id` | Unique, e.g. `seg_004_sfx_1`. |
| `search_query` | 2–4 plain words describing the **sound**, not the scene: `door slam`, `wind howling`, `can set down concrete`. |
| `alt_queries` | Fallback searches, broader each time. |
| `must_include_tags`, `exclude_tags` | e.g. exclude `music`, `voice`. |
| `placement` | `segment_start`, `segment_end`, `at_phrase` (needs `at_phrase`, a few consecutive words copied exactly from the narration) or `whole_segment` (ambience bed). |
| `offset_sec` | Shift from the anchor. |
| `duration_sec` | Cut the clip to this length. |
| `loop` | `true` for beds that must fill the segment (rain, wind, crowd). |
| `continues_into_next` | Bed carries on through the next segment. |
| `gain_db` | Level relative to the voice (default −18). Beds −20 to −26, impacts −10 to −16. Beds are ducked under the voice automatically. |
| `fade_in_ms`, `fade_out_ms` | Defaults 100 / 300. |

Use SFX sparingly: one bed per scene change plus impacts on story beats. Only commercially licensed clips are used (CC0, public domain, CC BY with credit, or your licensed local library), so very specific queries may find nothing; the cue is then left silent with a warning.

## thumbnail

| Field | Notes |
|---|---|
| `image_prompt` | Scene for the thumbnail base image: one strong subject, high contrast, empty space where text goes. **No text in the image**; text is added by `text_layers`. |
| `characters_present` | As for segments. |
| `text_layers[]` | Up to 4: `{ text, style, position, max_font_size_px }`. Styles `impact_white_black_outline`, `impact_yellow_black_outline`, `red_badge`, `plain_white`. Avoid `bottom_right` (YouTube's duration stamp). 1–3 words per layer. |
| `alt_variants` | 0–2 extra base images for A/B choice. |

## youtube

| Field | Notes |
|---|---|
| `channel_name` | Must match the channel the bot is signed into; the bot refuses otherwise. |
| `title` | ≤ 100 characters. |
| `description` | ≤ 5000 bytes after expansion. Put `{{chapters}}` and `{{sfx_credits}}` on their own lines; they are replaced with chapter timestamps and the required CC BY credits. If a placeholder is missing, that block is appended at the end instead. |
| `tags` | ≤ 500 characters total. |
| `category` | A YouTube category name (default `Entertainment`). |
| `visibility` | `private`, `unlisted`, `public` or `scheduled` (needs a future `scheduled_publish_at` with timezone offset). |
| `playlist`, `pinned_comment`, `end_screen_note` | Optional; the bot sets them. |
| `made_for_kids` | Default `false`. |
| `contains_altered_or_synthetic_media` | Default `true` (AI images and voice). Leave it `true`. |
| `chapters_from_segments` | Default `true`. |

## chapters

`[{ "segment_id": "seg_005", "title": "Day 2" }]`. YouTube needs at least 3 chapters, the first at 0:00 and each at least 10 s long. If your first chapter starts within 10 s it is moved to 0:00; later than that, an "Intro" chapter is added. If the rules still aren't met, chapters are left out with a warning.

## automation and render

- `automation.auto_start_on_submit` (default `true`): start as soon as the JSON is accepted.
- `automation.approval_gates.before_render` / `before_publish`: pause for a click in the dashboard.
- `automation.bot_triggers[]`: optional overrides for the image bot (batch size, output naming, retries, timeout). Leave out to use the defaults.
- `render`: `fps` (24/25/30/60), `burn_in_captions` + `caption_style` (`bottom_bar`, `bold_center`), `intro_sec`, `outro_sec`, `crf`, `audio_bitrate_kbps`. Defaults are fine.

## Writing checklist

- [ ] Every `illustration` has `image.prompt`; every card has a `remotion` block.
- [ ] Every character id used in `characters_present` exists in `style_bible.characters`.
- [ ] `at_phrase` text appears word-for-word in that segment's narration.
- [ ] No text, letters or signs requested inside any image prompt.
- [ ] Episode 2+: `recap_of_previous` and `state_carryover` agree with the previous episode's context block.
- [ ] Description contains `{{chapters}}` and `{{sfx_credits}}`.
