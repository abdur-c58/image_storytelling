import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialStoryState, type StoryState } from "@/lib/episode/continuity";
import { convertV1ToV2 } from "@/lib/episode/migrate";
import { assembleNegative, buildImageItems, buildMasterItems, buildThumbnailItems, pictureSourceSegmentId } from "@/lib/episode/prompt";
import { StoryBibleSchema, type StoryBible } from "@/lib/episode/schema";
import { parseTags, splitAtPauses, stripTags, ttsMatchesNarration } from "@/lib/episode/tags";
import { applyPronunciations, normalizePhrase, phraseInText } from "@/lib/episode/text";
import { validateDocument, validateText, type StoryContext } from "@/lib/episode/validate";
import { chapterProblem, formatYoutubeTimestamp, youtubeTagsLength } from "@/lib/episode/youtube";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const bible = (): StoryBible => StoryBibleSchema.parse(json("story_bible_example.json"));
const ctx = (state: StoryState | null = null): StoryContext => ({ bible: bible(), state });
const NOW = new Date("2026-10-12T00:00:00Z");
const validateEp = (obj: unknown, story: StoryContext | null = ctx()) => validateDocument(obj, { now: NOW, story });
const errorText = (r: ReturnType<typeof validateEp>) => r.errors.map((e) => `${e.path_text}: ${e.message}`).join("\n");

describe("fixtures", () => {
  it("story bible validates", () => {
    const r = validateText(fixture("story_bible_example.json"));
    expect(r.errors).toEqual([]);
    expect(r.doc_type).toBe("story_bible");
    expect(r.ok).toBe(true);
  });

  it("minimal episode validates against the story", () => {
    const r = validateText(fixture("episode_minimal.json"), { now: NOW, story: ctx() });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.episode?.series.series_id).toBe("rooftop-test");
    expect(r.episode?.youtube.channel_name).toBe("Test Channel");
    expect(r.estimate?.images_to_generate).toBe(2);
  });

  it("full episode validates with every feature", () => {
    const r = validateText(fixture("episode_full.json"), { now: NOW, story: ctx() });
    expect(r.errors).toEqual([]);
    const ep = r.episode!;
    expect(ep.segments).toHaveLength(10);
    expect(ep.crop_policy.min_hold_sec).toBe(1.2);
    expect(ep.voice.style_notes).toBe("calm, low, unhurried");
    expect(ep.story.scene_bible.locations.find((l) => l.id === "rooftop")!.camera_angles.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(r.continuity?.end.locations).toEqual({ rooftop: "barricaded", apartment: "ransacked" });
    expect(r.continuity?.end.world).toMatchObject({ day: 1, weather: "rain", water_gallons: 4990 });
    expect(r.continuity?.end.outfits.protagonist).toBe("bandaged");
    expect(r.continuity?.end.introduced_characters).toEqual(["protagonist"]);
  });

  it("an episode alone is checked without continuity until its story is known", () => {
    const r = validateText(fixture("episode_full.json"), { now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.needs_story).toBe("rooftop-test");
  });

  it("a bundle validates both parts", () => {
    const r = validateDocument(
      { schema_version: "2.0", doc_type: "bundle", story_bible: json("story_bible_example.json"), episode: json("episode_full.json") },
      { now: NOW },
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.story?.story_id).toBe("rooftop-test");
  });
});

describe("doc types and schema errors", () => {
  it("rejects v1 documents with a convert hint", () => {
    const r = validateText(fixture("v1/minimal_3_segments.json"));
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/schema 1.0/);
  });

  it("requires a doc_type", () => {
    expect(validateDocument({ schema_version: "2.0" }).errors[0].path_text).toBe("doc_type");
  });

  it("reports JSON syntax errors with a line number", () => {
    const r = validateText('{\n  "schema_version": "2.0",\n  // comment\n}');
    expect(r.errors[0].line).toBe(3);
    expect(r.errors[0].message).toMatch(/comments are not allowed/);
  });

  it("points zod errors at the right line, inside bundles too", () => {
    const text = fixture("episode_minimal.json").replace('"type": "illustration"', '"type": "photo"');
    const issue = validateText(text, { story: ctx() }).errors.find((e) => e.path_text === "segments[1].type");
    expect(issue?.line).toBeGreaterThan(1);
    expect(issue?.message).toMatch(/seg_002/);
    const bundle = { schema_version: "2.0", doc_type: "bundle", story_bible: json("story_bible_example.json"), episode: JSON.parse(text) };
    expect(validateDocument(bundle).errors.some((e) => e.path_text === "episode.segments[1].type")).toBe(true);
  });

  it("caps max_crop at 0.20", () => {
    const b = json("story_bible_example.json");
    b.defaults.crop_policy.max_crop = 0.3;
    expect(validateDocument(b).errors.some((e) => e.path_text === "defaults.crop_policy.max_crop")).toBe(true);
  });

  it("requires sentences_before_crop to sum to 1", () => {
    const b = json("story_bible_example.json");
    b.defaults.crop_policy.sentences_before_crop = { "2": 0.5, "1": 0.2 };
    expect(validateDocument(b).errors.some((e) => /add up to 1/.test(e.message))).toBe(true);
  });

  it("keeps unknown extra fields", () => {
    const ep = json("episode_minimal.json");
    ep.my_notes = { draft: 3 };
    const r = validateEp(ep);
    expect(r.ok).toBe(true);
    expect((r.episode as unknown as Record<string, unknown>).my_notes).toEqual({ draft: 3 });
  });
});

describe("continuity", () => {
  it("rejects a scene state that does not match the story state", () => {
    const ep = json("episode_full.json");
    ep.segments[5].scene.state_changes = [];
    const r = validateEp(ep);
    expect(errorText(r)).toMatch(/segments\[5\]\.scene\.state_id: seg_006: apartment is "tidy" here, but the scene says "ransacked"/);
  });

  it("rejects a state_change whose from_state is wrong", () => {
    const ep = json("episode_full.json");
    ep.segments[7].scene.state_changes[0].from_state_id = "barricaded";
    expect(errorText(validateEp(ep))).toMatch(/state_changes\[0\]\.from_state_id: seg_008: rooftop is "clear" at this point/);
  });

  it("non-persistent changes revert after the segment", () => {
    const ep = json("episode_full.json");
    ep.segments[7].scene.state_changes[0].persist = false;
    expect(errorText(validateEp(ep))).toMatch(/seg_009: rooftop is "clear" here/);
  });

  it("requires persist on every state change", () => {
    const ep = json("episode_full.json");
    delete ep.segments[7].scene.state_changes[0].persist;
    expect(errorText(validateEp(ep))).toMatch(/"persist" is required/);
  });

  it("errors on missing world variables, warns on monotonic and step violations", () => {
    const ep = json("episode_full.json");
    delete ep.segments[2].scene.world_state.weather;
    ep.segments[3].scene.world_state.day = 3;
    ep.segments[5].scene.world_state.day = 2;
    const r = validateEp(ep);
    expect(errorText(r)).toMatch(/seg_003: missing world variable "weather"/);
    const warnings = r.warnings.map((w) => w.message).join("\n");
    expect(warnings).toMatch(/"day" jumps 1 → 3/);
    expect(warnings).toMatch(/"day" goes down \(3 → 2\)/);
  });

  it("rejects enum values outside the list and unknown variables", () => {
    const ep = json("episode_full.json");
    ep.segments[2].scene.world_state.weather = "snow";
    ep.segments[2].scene.world_state.mood = "grim";
    const t = errorText(validateEp(ep));
    expect(t).toMatch(/"weather" must be one of/);
    expect(t).toMatch(/unknown world variable "mood"/);
  });

  it("rejects characters before their first episode unless they are cameos", () => {
    const ep = json("episode_full.json");
    ep.segments[8].scene.characters_present[1].cameo = false;
    expect(errorText(validateEp(ep))).toMatch(/mara first appears in episode 2/);
  });

  it("rejects unknown outfits, props, angles and locations", () => {
    const ep = json("episode_full.json");
    ep.segments[1].scene.characters_present[0].outfit_state_id = "tuxedo";
    ep.segments[2].scene.props_in_frame = ["piano"];
    ep.segments[3].scene.camera_angle_id = "z";
    ep.segments[4].scene = { location_id: "moon", state_id: "x", camera_angle_id: "a" };
    const t = errorText(validateEp(ep));
    expect(t).toMatch(/no outfit "tuxedo"/);
    expect(t).toMatch(/no prop "piano"/);
    expect(t).toMatch(/no camera angle "z"/);
    expect(t).toMatch(/unknown location "moon"/);
  });

  it("requires a scene on illustrations", () => {
    const ep = json("episode_minimal.json");
    delete ep.segments[1].scene;
    expect(errorText(validateEp(ep))).toMatch(/illustration segments need a "scene"/);
  });

  it("continues from the previous episode's committed state", () => {
    const ep2 = json("episode_minimal.json");
    ep2.series.episode_number = 2;
    const state = initialStoryState(bible());
    state.by_episode["1"] = { ...state.current, after_episode: 1, locations: { rooftop: "barricaded", apartment: "ransacked" } };
    const r = validateEp(ep2, ctx(state));
    expect(errorText(r)).toMatch(/rooftop is "barricaded" here, but the scene says "clear"/);
  });

  it("warns about too few channel cameos", () => {
    const ep = json("episode_minimal.json");
    ep.segments[1].scene.include_channel_cameo = false;
    expect(validateEp(ep).warnings.some((w) => /cameo appears in 0 segment/.test(w.message))).toBe(true);
  });
});

describe("bible_additions", () => {
  it("are append-only", () => {
    const ep = json("episode_full.json");
    ep.bible_additions.camera_angles.push({ location_id: "rooftop", angle: { id: "a", prompt: "redefined" } });
    ep.bible_additions.characters = [{ id: "mara", name: "Mara 2", visual_description: "x" }];
    ep.bible_additions.location_states = [{ location_id: "attic", state: { id: "dusty" } }];
    const t = errorText(validateEp(ep));
    expect(t).toMatch(/rooftop already has camera angle "a"; bible_additions can only add/);
    expect(t).toMatch(/Character "mara" already exists/);
    expect(t).toMatch(/Unknown location "attic"/);
  });

  it("an angle used before it is added is an error", () => {
    const ep = json("episode_full.json");
    ep.bible_additions.camera_angles = [];
    expect(errorText(validateEp(ep))).toMatch(/seg_008: rooftop has no camera angle "c"/);
  });
});

describe("voice tags", () => {
  it("strips both tag syntaxes and compares with narration", () => {
    expect(stripTags("[breath] Hello, [short pause] world. <whisper>Quiet</whisper> now.")).toBe("Hello, world. Quiet now.");
    expect(ttsMatchesNarration("[pause] It was <emphasis>three</emphasis> cans.", "It was three cans.")).toBe(true);
    expect(ttsMatchesNarration("[pause] It was four cans.", "It was three cans.")).toBe(false);
  });

  it("reports unbalanced brackets and unclosed paired tags", () => {
    expect(parseTags("Hello [pause world.").problems[0].message).toMatch(/Unbalanced "\["/);
    expect(parseTags("<whisper>Hello").problems[0].message).toMatch(/never closed/);
    expect(parseTags("<slow><soft>Hi</slow></soft>").problems[0].message).toMatch(/reverse order/);
  });

  it("validates tts_text against narration, whitelist and density", () => {
    const ep = json("episode_full.json");
    ep.segments[2].tts_text = "[breath] From up here, the roads looked like a model town. [long pause] Nothing moved at all.";
    ep.segments[5].tts_text = ep.segments[5].tts_text.replace("[sigh]", "[gasp]");
    ep.segments[7].tts_text = "<shout>That afternoon, the rain came.</shout> You dragged a filing cabinet up the stairs. You wedged the door shut.";
    ep.segments[1].narration = "The morning the city went quiet, [pause] you climbed to the roof.";
    ep.segments[8].tts_text = "[pause] [breath] [pause] [sigh] [pause] Then, through the rain, you heard it. [pause] Three slow knocks on the door.";
    const r = validateEp(ep);
    const t = errorText(r);
    expect(t).toMatch(/seg_003: tts_text without tags must match narration word for word \(tts_text has "roads looked like a", narration has "streets looked like a"\)/);
    expect(t).toMatch(/seg_008: <shout> is not a supported paired tag/);
    expect(t).toMatch(/seg_002: narration must be clean text/);
    const w = r.warnings.map((x) => x.message).join("\n");
    expect(w).toMatch(/seg_006: \[gasp\] is not in voice.tag_whitelist/);
    expect(w).toMatch(/seg_009: 6 tags for 13 words is dense/);
  });

  it("unknown tags can be made errors", () => {
    const b = bible();
    b.defaults.voice.unknown_tag_level = "error";
    const ep = json("episode_full.json");
    ep.segments[5].tts_text = ep.segments[5].tts_text.replace("[sigh]", "[gasp]");
    expect(validateEp(ep, { bible: b, state: null }).errors.some((e) => /\[gasp\]/.test(e.message))).toBe(true);
  });

  it("splits tts_text at pauses for the split_and_silence fallback", () => {
    const chunks = splitAtPauses("[breath] One. [long pause] <whisper>Two [pause] three.</whisper> [short pause]", {
      pause: 700,
      "long pause": 1200,
      "short pause": 400,
    });
    expect(chunks).toEqual([
      { kind: "speech", text: "[breath] One." },
      { kind: "silence", ms: 1200 },
      { kind: "speech", text: "<whisper>Two</whisper>" },
      { kind: "silence", ms: 700 },
      { kind: "speech", text: "<whisper>three.</whisper>" },
    ]);
  });

  it("checks sentence_split_override words", () => {
    const ep = json("episode_full.json");
    ep.segments[3].sentence_split_override = ["Back inside, the apartment looked the same as always.", "The sofa."];
    expect(errorText(validateEp(ep))).toMatch(/sentence_split_override must contain exactly the narration's words/);
  });

  it("warns about removed v1 image fields", () => {
    const ep = json("episode_minimal.json");
    ep.segments[1].image.motion = "slow_zoom_in";
    expect(validateEp(ep).warnings.some((w) => /image.motion was removed/.test(w.message))).toBe(true);
  });
});

describe("prompt assembly", () => {
  const full = validateText(fixture("episode_full.json"), { now: NOW, story: ctx() }).episode!;

  it("builds style + anchor + state + angle + world + characters + props + scene in order", () => {
    const seg8 = buildImageItems(full).find((i) => i.segment_id === "seg_008")!;
    expect(seg8.prompt_parts.map((p) => p.kind)).toEqual(["style", "anchor", "anchor", "state", "angle", "world", "world", "character", "props", "scene"]);
    expect(seg8.final_prompt.startsWith("Flat 2D cartoon illustration")).toBe(true);
    expect(seg8.final_prompt).toContain("Always visible and unchanged: a round grey water tank on steel legs; a small stairwell hut with a red metal door.");
    expect(seg8.final_prompt).toContain("Current state: the red stairwell door wedged shut");
    expect(seg8.final_prompt).toContain("Camera: high overhead shot looking straight down at the roof.");
    expect(seg8.final_prompt).toContain("Day 1 of the outbreak. Weather: rain.");
    expect(seg8.final_prompt).toContain("You: a stick figure with a round white head and dot eyes; wearing a mustard yellow beanie under a dark green hooded raincoat");
    expect(seg8.final_prompt).toContain("Props in frame: a blue plastic rain barrel (next to the water tank).");
    expect(seg8.final_prompt).toMatch(/Scene: Heavy rain streaks, puddles forming on the concrete\.$/);
    expect(seg8.final_prompt).not.toContain("\n");
    expect(seg8.master_keys).toEqual(["loc/rooftop/barricaded/c", "char/protagonist/raincoat"]);
  });

  it("carries outfits forward and adds the channel cameo", () => {
    const items = buildImageItems(full);
    const seg3 = items.find((i) => i.segment_id === "seg_003")!;
    expect(seg3.final_prompt).toContain("wearing a mustard yellow beanie and a grey scarf");
    expect(seg3.final_prompt).not.toContain("Weather: rain");
    const seg2 = items.find((i) => i.segment_id === "seg_002")!;
    expect(seg2.final_prompt).toContain("Somewhere in frame: a small orange cat");
    const seg4 = items.find((i) => i.segment_id === "seg_004")!;
    expect(seg4.final_prompt).not.toContain("Weather:");
  });

  it("skips reuse segments and cards without image backgrounds", () => {
    const ids = buildImageItems(full).map((i) => i.segment_id);
    expect(ids).toEqual(["seg_002", "seg_003", "seg_004", "seg_006", "seg_008", "seg_009"]);
    const seg7 = full.segments.find((s) => s.id === "seg_007")!;
    expect(pictureSourceSegmentId(full, seg7)).toBe("seg_004");
  });

  it("uses the thumbnail scene", () => {
    const [th] = buildThumbnailItems(full);
    expect(th.final_prompt).toContain("Current state: the red stairwell door wedged shut");
    expect(th.master_keys[0]).toBe("loc/rooftop/barricaded/a");
    expect(assembleNegative(full, "text")).toBe("photorealistic, 3d render, text, watermark, text");
  });

  it("builds one empty master per location/state/angle and one sheet per outfit", () => {
    const masters = buildMasterItems(bible());
    expect(masters.filter((m) => m.kind === "location")).toHaveLength(8);
    expect(masters.filter((m) => m.kind === "character").map((m) => m.master_key)).toEqual([
      "char/protagonist/beanie",
      "char/protagonist/raincoat",
      "char/mara/default",
    ]);
    const plate = masters.find((m) => m.master_key === "loc/rooftop/clear/a")!;
    expect(plate.final_prompt).toContain("no people");
    expect(plate.must_match).toContain("a round grey water tank on steel legs");
  });
});

describe("v1 → v2 migration", () => {
  it("converts the v1 full example into a valid bundle", () => {
    const { bundle, notes } = convertV1ToV2(json("v1/full_example.json"));
    const r = validateDocument(bundle, { now: NOW });
    expect(errorText(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(notes.some((n) => /placeholder location/.test(n))).toBe(true);
    expect(r.episode?.crop_policy.enabled).toBe(false);
  });
});

describe("youtube helpers", () => {
  it("counts tags like YouTube Studio", () => {
    expect(youtubeTagsLength([])).toBe(0);
    expect(youtubeTagsLength(["zombie"])).toBe(6);
    expect(youtubeTagsLength(["zombie", "story"])).toBe(12);
    expect(youtubeTagsLength(["zombie story", "a"])).toBe(14 + 1 + 1);
  });

  it("formats chapter timestamps and validates chapter rules", () => {
    expect(formatYoutubeTimestamp(0)).toBe("0:00");
    expect(formatYoutubeTimestamp(75.9)).toBe("1:15");
    expect(formatYoutubeTimestamp(3725)).toBe("1:02:05");
    const ok = [
      { title: "A", start_seconds: 0 },
      { title: "B", start_seconds: 30 },
      { title: "C", start_seconds: 60 },
    ];
    expect(chapterProblem(ok, 120)).toBeNull();
    expect(chapterProblem(ok.slice(0, 2), 120)).toMatch(/at least 3/);
    expect(chapterProblem(ok, 65)).toMatch(/shorter than 10/);
  });
});

describe("text helpers", () => {
  it("matches phrases ignoring case and punctuation", () => {
    expect(normalizePhrase("Three slow knocks.  Then—nothing!")).toBe("three slow knocks then nothing");
    expect(phraseInText("three SLOW knocks", "That night something knocks on the hatch. Three slow knocks. Then nothing.")).toBe(true);
    expect(phraseInText("slow knock", "Three slow knocks.")).toBe(false);
  });

  it("applies pronunciation overrides as whole words", () => {
    expect(applyPronunciations("Inez says hi to Inez's cat and Inezia.", { Inez: "ee-NEZ" })).toBe("ee-NEZ says hi to ee-NEZ's cat and Inezia.");
  });
});
