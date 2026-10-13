import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assembleNegative, assemblePrompt, buildImageItems, buildThumbnailItems, pictureSourceSegmentId } from "@/lib/episode/prompt";
import { applyPronunciations, normalizePhrase, phraseInText } from "@/lib/episode/text";
import { validateEpisodeText } from "@/lib/episode/validate";
import { chapterProblem, formatYoutubeTimestamp, youtubeTagsLength } from "@/lib/episode/youtube";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const minimal = () => JSON.parse(fixture("minimal_3_segments.json"));
const validate = (obj: unknown) => validateEpisodeText(JSON.stringify(obj, null, 2), { now: new Date("2026-10-12T00:00:00Z") });

describe("fixtures", () => {
  it("minimal fixture validates", () => {
    const result = validateEpisodeText(fixture("minimal_3_segments.json"));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.estimate?.images_to_generate).toBe(2);
  });

  it("full fixture validates with every feature", () => {
    const result = validateEpisodeText(fixture("full_example.json"));
    expect(result.errors).toEqual([]);
    expect(result.episode?.segments).toHaveLength(22);
  });
});

describe("schema errors", () => {
  it("reports JSON syntax errors with a line number", () => {
    const result = validateEpisodeText('{\n  "schema_version": "1.0",\n  // comment\n}');
    expect(result.ok).toBe(false);
    expect(result.errors[0].line).toBe(3);
    expect(result.errors[0].message).toMatch(/comments are not allowed/);
  });

  it("points zod errors at the right line", () => {
    const text = fixture("minimal_3_segments.json").replace('"type": "illustration"', '"type": "photo"');
    const result = validateEpisodeText(text);
    const issue = result.errors.find((e) => e.path_text === "segments[1].type");
    expect(issue).toBeDefined();
    expect(issue!.line).toBeGreaterThan(1);
    expect(issue!.message).toMatch(/seg_002/);
  });

  it("rejects duplicate ids and non-contiguous order", () => {
    const ep = minimal();
    ep.segments[2].id = "seg_002";
    ep.segments[2].order = 5;
    const messages = validate(ep).errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/Duplicate segment id/);
    expect(messages).toMatch(/contiguous/);
  });

  it("requires image.prompt for illustrations and remotion for cards", () => {
    const ep = minimal();
    ep.segments[1].image.prompt = "";
    delete ep.segments[2].remotion;
    const messages = validate(ep).errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/illustration needs "image.prompt"/);
    expect(messages).toMatch(/infographic needs a "remotion" block/);
  });

  it("rejects placeholder reference image URLs", () => {
    const ep = minimal();
    ep.style_bible.reference_assets = [{ id: "ref_1", description: "front", asset_url_or_path: "https://example.com/a.png" }];
    ep.style_bible.characters[0].reference_image_ids = ["ref_1"];
    expect(validate(ep).errors.map((e) => e.message).join("\n")).toMatch(/placeholder address/);
  });

  it("requires reuse_image to point at an earlier segment", () => {
    const ep = minimal();
    ep.segments[1] = { id: "seg_002", order: 2, type: "reuse_image", narration: "Hi.", image: { reuse_from_segment_id: "seg_003" } };
    expect(validate(ep).errors.map((e) => e.message).join("\n")).toMatch(/must come before/);
  });

  it("requires narration unless silent", () => {
    const ep = minimal();
    ep.segments[1].narration = "  ";
    expect(validate(ep).errors.some((e) => e.message.includes('"narration" is required'))).toBe(true);
  });

  it("rejects unknown templates and placements", () => {
    const ep = minimal();
    ep.segments[2].remotion.template = "bar_chart";
    ep.segments[1].sfx[0].placement = "somewhere";
    const paths = validate(ep).errors.map((e) => e.path_text);
    expect(paths).toContain("segments[2].remotion.template");
    expect(paths).toContain("segments[1].sfx[0].placement");
  });

  it("enforces YouTube limits", () => {
    const ep = minimal();
    ep.youtube.title = "x".repeat(101);
    ep.youtube.tags = Array.from({ length: 60 }, (_, i) => `tag number ${i}`);
    ep.youtube.description = "é".repeat(2600);
    const messages = validate(ep).errors.map((e) => e.message).join("\n");
    expect(messages).toMatch(/Title is 101 characters/);
    expect(messages).toMatch(/Tags total/);
    expect(messages).toMatch(/bytes/);
  });

  it("requires a future scheduled_publish_at", () => {
    const ep = minimal();
    ep.youtube.visibility = "scheduled";
    expect(validate(ep).errors.some((e) => e.path_text === "youtube.scheduled_publish_at")).toBe(true);
    ep.youtube.scheduled_publish_at = "2020-01-01T00:00:00Z";
    expect(validate(ep).errors.some((e) => e.message.includes("future"))).toBe(true);
    ep.youtube.scheduled_publish_at = "2027-01-01T10:00:00Z";
    expect(validate(ep).ok).toBe(true);
  });

  it("keeps unknown extra fields", () => {
    const ep = minimal();
    ep.my_notes = { draft: 3 };
    ep.segments[0].writer_comment = "keep me";
    const result = validate(ep);
    expect(result.ok).toBe(true);
    expect((result.episode as Record<string, unknown>).my_notes).toEqual({ draft: 3 });
  });
});

describe("warnings", () => {
  it("warns (not errors) about long narration, missing phrase and short runtime", () => {
    const ep = minimal();
    ep.segments[1].narration = Array.from({ length: 70 }, () => "word").join(" ");
    ep.segments[2].sfx[0].at_phrase = "not in the text";
    const result = validate(ep);
    expect(result.ok).toBe(true);
    const messages = result.warnings.map((w) => w.message).join("\n");
    expect(messages).toMatch(/70 words/);
    expect(messages).toMatch(/not in this segment's narration/);
    expect(messages).toMatch(/under 5 minutes/);
  });

  it("warns about unknown icons", () => {
    const ep = minimal();
    ep.segments[2].remotion.props.items[0].icon = "spaceship";
    expect(validate(ep).warnings.some((w) => w.message.includes('unknown icon "spaceship"'))).toBe(true);
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
    expect(applyPronunciations("Inez says hi to Inez's cat and Inezia.", { Inez: "ee-NEZ" })).toBe(
      "ee-NEZ says hi to ee-NEZ's cat and Inezia.",
    );
  });
});

describe("prompt assembly", () => {
  const full = validateEpisodeText(fixture("full_example.json")).episode!;

  it("prepends the style bible and character descriptions", () => {
    const items = buildImageItems(full);
    const seg5 = items.find((i) => i.segment_id === "seg_005")!;
    expect(seg5.final_prompt.startsWith("Flat 2D cartoon illustration")).toBe(true);
    expect(seg5.final_prompt).toContain("Inez: an older woman with short white hair, round red glasses");
    expect(seg5.final_prompt).toContain("Shot: medium.");
    expect(seg5.final_prompt).toMatch(/Scene: Inez asleep under a tilted solar panel.*\.$/);
    expect(seg5.final_prompt).not.toContain("\n");
    expect(seg5.reference_image_urls).toEqual([]);
    expect(seg5.output_filename).toBe("seg_005.png");
  });

  it("passes character reference URLs to the image items", () => {
    const raw = JSON.parse(fixture("full_example.json"));
    raw.style_bible.reference_assets = [
      { id: "protagonist_ref_1", description: "front", asset_url_or_path: "https://cdn.refs.test/protagonist_front.png" },
      { id: "inez_ref_1", description: "front", asset_url_or_path: "https://cdn.refs.test/inez_front.png" },
    ];
    raw.style_bible.characters[0].reference_image_ids = ["protagonist_ref_1"];
    raw.style_bible.characters[1].reference_image_ids = ["inez_ref_1"];
    const result = validate(raw);
    expect(result.errors).toEqual([]);
    const seg5 = buildImageItems(result.episode!).find((i) => i.segment_id === "seg_005")!;
    expect(seg5.reference_image_urls).toEqual([
      "https://cdn.refs.test/inez_front.png",
      "https://cdn.refs.test/protagonist_front.png",
    ]);
  });

  it("merges negative prompts", () => {
    expect(assembleNegative(full, "zombies visible")).toMatch(/deformed hands, zombies visible$/);
    expect(assemblePrompt(full, "a door", [])).toContain("Scene: a door.");
  });

  it("skips reuse segments and cards without image backgrounds", () => {
    const ids = buildImageItems(full).map((i) => i.segment_id);
    expect(ids).not.toContain("seg_012");
    expect(ids).not.toContain("seg_004");
    expect(ids).not.toContain("seg_017");
    expect(ids).toHaveLength(13);
  });

  it("builds thumbnail variants and resolves reuse chains", () => {
    expect(buildThumbnailItems(full).map((i) => i.output_filename)).toEqual(["thumbnail_base_0.png", "thumbnail_base_1.png"]);
    const seg12 = full.segments.find((s) => s.id === "seg_012")!;
    const seg17 = full.segments.find((s) => s.id === "seg_017")!;
    const seg4 = full.segments.find((s) => s.id === "seg_004")!;
    expect(pictureSourceSegmentId(full, seg12)).toBe("seg_011");
    expect(pictureSourceSegmentId(full, seg17)).toBe("seg_016");
    expect(pictureSourceSegmentId(full, seg4)).toBeNull();
  });
});
