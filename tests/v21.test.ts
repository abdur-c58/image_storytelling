import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planSegmentCrops, type FocalPoint } from "@/lib/crop/plan";
import type { SentenceTiming } from "@/lib/crop/sentences";
import { timeSegmentSentences } from "@/lib/crop/timeline";
import { expandCast, type CastRegistry } from "@/lib/episode/cast";
import type { IssueSink } from "@/lib/episode/continuity";
import { buildImageItems, buildMasterItems, buildThumbnailItems } from "@/lib/episode/prompt";
import { CropPolicySchema, StoredStoryBibleSchema, StoryBibleSchema, type StoryBible } from "@/lib/episode/schema";
import { segmentSentenceUnits } from "@/lib/episode/sentences";
import { validateDocument, validateText, type StoryContext, type ValidationResult } from "@/lib/episode/validate";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const bible = (): StoryBible => StoredStoryBibleSchema.parse(json("story_bible_example.json"));
const NOW = new Date("2026-10-12T00:00:00Z");
const validateEp = (obj: unknown, b: StoryBible = bible()) => validateDocument(obj, { now: NOW, story: { bible: b, state: null } as StoryContext });
const errors = (r: ValidationResult) => r.errors.map((e) => `${e.path_text}: ${e.message}`).join("\n");
const warnings = (r: ValidationResult) => r.warnings.map((e) => `${e.path_text}: ${e.message}`).join("\n");
interface RawSegment {
  narration?: string;
  lines: Record<string, unknown>[];
  scene: { characters_present: Record<string, unknown>[]; state_changes?: Record<string, unknown>[] };
}
const seg = (ep: { segments: { id: string }[] }, id: string) => ep.segments.find((s) => s.id === id) as unknown as RawSegment;

function sink() {
  const out = { errors: [] as string[], warnings: [] as string[] };
  const issues: IssueSink = {
    error: (_p, m) => out.errors.push(m),
    warn: (_p, m) => out.warnings.push(m),
  };
  return { out, issues };
}

function registryFrom(b: StoryBible): CastRegistry {
  return new Map(
    b.characters
      .filter((c) => c.scope === "channel")
      .map((c) => [c.id, { id: c.id, definition: c, reference_assets: [], origin_story_id: b.story_id }]),
  );
}

describe("lines and speakers", () => {
  it("normalises narration into one narrator line and joins dialogue for whole-text uses", () => {
    const r = validateEp(json("episode_full.json"));
    expect(r.errors).toEqual([]);
    const ep = r.episode!;
    const s2 = ep.segments.find((s) => s.id === "seg_002")!;
    expect(s2.lines).toEqual([expect.objectContaining({ id: "seg_002_l1", speaker: "narrator", on_screen: false })]);
    const s10 = ep.segments.find((s) => s.id === "seg_010")!;
    expect(s10.lines!.map((l) => l.speaker)).toEqual(["mara", "narrator", "mara"]);
    expect(s10.narration).toBe("It's me. Open up before they hear us. You pulled two planks loose. A tall girl in a red hoodie squeezed through the gap. Thanks. I'm Mara. I saw your light from the next tower.");
    expect(ep.voices.mara.voice_id).toBe("test-voice-mara");
    expect(ep.voices.dex.voice_id).toBe("test-voice-dex");
    expect(ep.voices.narrator).toBeDefined();
  });

  it("rejects unknown speakers, speakers without a voice, and narration + lines together", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_010").lines[0].speaker = "ghost";
    seg(ep, "seg_012").lines[0].speaker = "protagonist";
    seg(ep, "seg_011").narration = "Also narration.";
    const t = errors(validateEp(ep));
    expect(t).toMatch(/seg_010: unknown speaker "ghost"/);
    expect(t).toMatch(/seg_012: protagonist has no "voice" in the story bible/);
    expect(t).toMatch(/seg_011.*narration.*lines|lines.*narration/);
  });

  it("checks brackets in line text and tts_text against the text", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_010").lines[1].text = "You pulled [pause] two planks loose.";
    seg(ep, "seg_010").lines[2].tts_text = "Thanks. I'm Mara. I saw your torch from the next tower.";
    const t = errors(validateEp(ep));
    expect(t).toMatch(/seg_010\/seg_010_l2: the line text must be clean text/);
    expect(t).toMatch(/seg_010\/seg_010_l3: tts_text without tags must match the line text word for word/);
  });

  it("warns when two speakers share a voice_id unless they share a voice_group", () => {
    const b = json("story_bible_example.json");
    b.characters[2].voice.voice_id = "test-voice-mara";
    expect(warnings(validateDocument(b))).toMatch(/dex uses the same voice_id as mara/);
    b.characters[1].voice_group = "twins";
    b.characters[2].voice_group = "twins";
    expect(warnings(validateDocument(b))).not.toMatch(/same voice_id/);
  });

  it("splits sentences across lines and tags them with line and speaker", () => {
    const ep = validateEp(json("episode_full.json")).episode!;
    const units = segmentSentenceUnits(ep.segments.find((s) => s.id === "seg_010")!);
    expect(units.map((u) => [u.line_id, u.speaker, u.on_screen])).toEqual([
      ["seg_010_l1", "mara", false],
      ["seg_010_l1", "mara", false],
      ["seg_010_l2", "narrator", false],
      ["seg_010_l2", "narrator", false],
      ["seg_010_l3", "mara", true],
      ["seg_010_l3", "mara", true],
      ["seg_010_l3", "mara", true],
    ]);
  });

  it("times sentences inside each line's window", () => {
    const units = [
      { text: "Hello there.", line_id: "l1", line_index: 0, speaker: "narrator", on_screen: false },
      { text: "Hi.", line_id: "l2", line_index: 1, speaker: "mara", on_screen: true },
    ];
    const words = [
      { word: "Hello", start: 10.0, end: 10.4 },
      { word: "there", start: 10.4, end: 10.9 },
      { word: "Hi", start: 11.3, end: 11.6 },
    ];
    const lines = [
      { line_id: "l1", speaker: "narrator", start: 0, end: 1.0 },
      { line_id: "l2", speaker: "mara", start: 1.22, end: 1.7 },
    ];
    const t = timeSegmentSentences(units, words, 10, 11.7, lines);
    expect(t.map((s) => [s.index, s.speaker, s.line_id])).toEqual([
      [0, "narrator", "l1"],
      [1, "mara", "l2"],
    ]);
    expect(t[1].start_sec).toBeCloseTo(11.3, 1);
  });
});

describe("POV (without a 2.2 identification block)", () => {
  const plainBible = () => {
    const b = bible();
    b.narrator.identification = null;
    return b;
  };

  it("warns when a second-person narrator names the POV character", () => {
    const b = plainBible();
    b.characters[0].name = "Sam";
    const ep = json("episode_full.json");
    seg(ep, "seg_002").narration = "The morning the city went quiet, Sam climbed to the roof.";
    expect(warnings(validateEp(ep, b))).toMatch(/seg_002: in a second-person story the narrator shouldn't name the POV character \("Sam"\)/);
  });

  it("does not treat a pronoun name like \"You\" as a name", () => {
    expect(warnings(validateEp(json("episode_full.json"), plainBible()))).not.toMatch(/shouldn't name the POV character/);
  });

  it("warns when the POV character is missing from a present-day picture, but not from a flashback", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_003").scene.characters_present = [];
    const w = warnings(validateEp(ep, plainBible()));
    expect(w).toMatch(/seg_003: second-person story, but the POV character \(protagonist\) isn't in this present-day picture/);
    expect(w).not.toMatch(/seg_011: second-person story/);
  });
});

describe("character status", () => {
  it("blocks absent characters from present-day pictures and on-screen speech", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_010").scene.characters_present.push({ character_id: "dex", outfit_state_id: "default", position_in_frame: "center" });
    seg(ep, "seg_010").lines.push({ id: "seg_010_l4", speaker: "dex", text: "Hello again." });
    const t = errors(validateEp(ep));
    expect(t).toMatch(/seg_010: dex is "separated" at this point and can't be in a present-day picture/);
    expect(t).toMatch(/seg_010: dex is "separated" here, so they can't speak in the present/);
  });

  it("allows radio/phone lines, written notes and flashbacks", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_010").lines.push({ id: "seg_010_l4", speaker: "dex", text: "Left you a note, kid.", source: "written", on_screen: false });
    seg(ep, "seg_010").lines.push({ id: "seg_010_l5", speaker: "dex", text: "Pick up.", voice_effect: "phone", on_screen: false });
    expect(validateEp(ep).errors).toEqual([]);
  });

  it("applies an absent status after its segment", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_012").lines.push({ id: "seg_012_l4", speaker: "dex", text: "Still here.", voice_effect: "radio", on_screen: false });
    expect(validateEp(ep).errors).toEqual([]);
    ep.character_status_changes.push({ character_id: "dex", to_status: "with_protagonist", at_segment_id: "seg_013", cause: "He walked in." });
    expect(validateEp(ep).errors).toEqual([]);
  });

  it("treats deceased as final unless story_override is set", () => {
    const ep = json("episode_full.json");
    ep.character_status_changes = [
      { character_id: "dex", to_status: "deceased", at_segment_id: "seg_002", cause: "Lost." },
      { character_id: "dex", to_status: "returned", at_segment_id: "seg_012", cause: "Back?" },
    ];
    expect(errors(validateEp(ep))).toMatch(/dex is deceased; bringing them back needs "story_override": true/);
    ep.character_status_changes[1].story_override = true;
    expect(errors(validateEp(ep))).not.toMatch(/deceased/);
  });

  it("ignores state changes in a flashback and keeps the story state", () => {
    const ep = json("episode_full.json");
    seg(ep, "seg_011").scene.state_changes = [{ location_id: "rooftop", from_state_id: "clear", to_state_id: "barricaded", cause: "x", persist: true }];
    const r = validateEp(ep);
    expect(r.errors).toEqual([]);
    expect(warnings(r)).toMatch(/seg_011: a flashback scene doesn't change the story/);
  });
});

describe("channel cast", () => {
  const first = bible();
  const registry = registryFrom(first);

  it("expands { ref } entries and adds story outfits", () => {
    const { out, issues } = sink();
    const doc = StoryBibleSchema.parse(json("story_bible_second.json"));
    const b = expandCast(doc, registry, issues);
    expect(out.errors).toEqual([]);
    const mara = b.characters.find((c) => c.id === "mara")!;
    expect(mara.visual_description).toBe("a tall stick figure with a black ponytail and round glasses");
    expect(mara.outfit_states.map((o) => o.id)).toEqual(["default", "wetsuit"]);
    expect(mara.voice?.voice_id).toBe("test-voice-mara");
    expect(b.characters.find((c) => c.id === "dex")!.initial_status).toBe("with_protagonist");
  });

  it("rejects changes to a channel character from another story, with a diff", () => {
    const { out, issues } = sink();
    const doc = StoryBibleSchema.parse(json("story_bible_second.json"));
    doc.characters[0] = { ...first.characters[1], visual_description: "a short figure with red hair" };
    expect(expandCast(doc, registry, issues)).toBeDefined();
    expect(out.errors.join("\n")).toMatch(/Channel character "mara" can't be changed by this story.*visual_description: registry "a tall stick figure/);
  });

  it("rejects redefining a channel character as a story character, and unknown refs", () => {
    const { out, issues } = sink();
    const doc = StoryBibleSchema.parse(json("story_bible_second.json"));
    doc.characters[0] = { ...first.characters[1], scope: "story" as const };
    doc.characters[1] = { ref: "nobody", story_outfit_states: [] };
    expandCast(doc, registry, issues);
    const t = out.errors.join("\n");
    expect(t).toMatch(/"mara" is a channel character .* Use \{ "ref": "mara" \}/);
    expect(t).toMatch(/Unknown channel character "nobody"/);
  });

  it("an unchanged full definition is fine, a refined one by the origin story is a warning", () => {
    const { out, issues } = sink();
    const doc = StoryBibleSchema.parse(json("story_bible_example.json"));
    expandCast(doc, registry, issues);
    expect(out.errors).toEqual([]);
    (doc.characters[1] as { visual_description: string }).visual_description = "taller now";
    expandCast(doc, registry, issues);
    expect(out.warnings.join("\n")).toMatch(/Saving changes channel character "mara" for every story/);
  });

  it("without a registry, refs are placeholders with a warning (browser preview)", () => {
    const r = validateText(fixture("story_bible_second.json"));
    expect(r.errors).toEqual([]);
    expect(warnings(r)).toMatch(/"mara" is taken from the channel cast when the story is saved/);
  });
});

describe("multi-character images", () => {
  const ep = validateEp(json("episode_full.json")).episode!;
  const items = buildImageItems(ep);

  it("describes every character with position, counts them and guards against merged faces", () => {
    const s10 = items.find((i) => i.segment_id === "seg_010")!;
    expect(s10.final_prompt).toContain("Exactly 2 different people");
    expect(s10.final_prompt).toMatch(/You: .*left/);
    expect(s10.final_prompt).toMatch(/Mara: a tall stick figure.*right/);
    expect(s10.negative_prompt).toContain("merged faces");
    expect(s10.master_keys).toContain("group/you_and_mara");
    const s3 = items.find((i) => i.segment_id === "seg_003")!;
    expect(s3.negative_prompt).not.toContain("merged faces");
  });

  it("tints flashbacks", () => {
    const s11 = items.find((i) => i.segment_id === "seg_011")!;
    expect(s11.prompt_parts.some((p) => p.kind === "treatment")).toBe(true);
    expect(s11.final_prompt).toContain("sepia");
    expect(s11.master_keys).not.toContain("group/you_and_mara");
  });

  it("uses the thumbnail pairing layout", () => {
    const [th] = buildThumbnailItems(ep);
    expect(th.final_prompt).toMatch(/foreground/i);
    expect(th.negative_prompt).toContain("merged faces");
  });

  it("builds a group master sheet", () => {
    const group = buildMasterItems(bible()).find((m) => m.kind === "group")!;
    expect(group.master_key).toBe("group/you_and_mara");
    expect(group.final_prompt).toContain("Exactly 2 different people");
    expect(group.must_match).toHaveLength(2);
  });
});

describe("speaker-aware crops", () => {
  const policy = CropPolicySchema.parse({ enabled: true, focal_bias: 1, sentences_before_crop: { "1": 1 }, min_hold_sec: 0.5, prob_typical: 1 });
  const sentences: SentenceTiming[] = [
    { index: 0, text: "A.", start_sec: 0, end_sec: 2, speaker: "narrator", on_screen: false },
    { index: 1, text: "B.", start_sec: 2.4, end_sec: 4, speaker: "mara", on_screen: true },
    { index: 2, text: "C.", start_sec: 4.4, end_sec: 6, speaker: "mara", on_screen: true },
    { index: 3, text: "D.", start_sec: 6.4, end_sec: 8, speaker: "narrator", on_screen: false },
  ];
  const mara: FocalPoint = { label: "mara", x: 0.75, y: 0.45 };

  it("starts a crop on a speaker change and aims at the on-screen speaker", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const plan = planSegmentCrops({ sentences, segment_start: 0, segment_end: 8, policy, focal_points: [], speaker_focal: { mara }, seed });
      const crop = plan.find((k) => k.kind === "crop")!;
      expect(crop.sentence_index).toBe(1);
      expect(crop.focal_label).toBe("mara");
      expect(crop.rect.x + crop.rect.w / 2).toBeGreaterThan(0.5);
    }
  });

  it("does not aim at the narrator", () => {
    const narr = sentences.map((s) => ({ ...s, speaker: "narrator", on_screen: false }));
    const plan = planSegmentCrops({ sentences: narr, segment_start: 0, segment_end: 8, policy, focal_points: [], speaker_focal: { mara }, seed: "a" });
    expect(plan.find((k) => k.kind === "crop")?.focal_label ?? null).toBeNull();
  });
});
