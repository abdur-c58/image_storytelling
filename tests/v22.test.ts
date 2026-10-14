import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EpisodeDocSchema, StoredStoryBibleSchema, type StoryBible } from "@/lib/episode/schema";
import { onScreenReport, povNameMatcher, roleChapters } from "@/lib/episode/structure";
import { validateDocument, type StoryContext, type ValidationResult } from "@/lib/episode/validate";
import { buildChapters } from "@/lib/pipeline/description";

const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const bible = (): StoryBible => StoredStoryBibleSchema.parse(json("story_bible_example.json"));
const NOW = new Date("2026-10-12T00:00:00Z");
const validateEp = (obj: unknown, b: StoryBible = bible()) => validateDocument(obj, { now: NOW, story: { bible: b, state: null } as StoryContext });
const errors = (r: ValidationResult) => r.errors.map((e) => `${e.path_text}: ${e.message}`).join("\n");
const warnings = (r: ValidationResult) => r.warnings.map((e) => `${e.path_text}: ${e.message}`).join("\n");

interface RawSegment {
  id: string;
  order: number;
  type: string;
  role?: string;
  narration?: string;
  silent?: boolean;
  lines?: Record<string, unknown>[];
  remotion?: { template: string; props: Record<string, unknown> };
  scene: { characters_present: Record<string, unknown>[]; pov_exception_reason?: string | null };
}
interface RawEpisode {
  schema_version: string;
  series: Record<string, unknown>;
  overrides: Record<string, unknown>;
  segments: RawSegment[];
  chapters: unknown[];
}
const episode = (): RawEpisode => json("episode_full.json");
const seg = (ep: RawEpisode, id: string) => ep.segments.find((s) => s.id === id)!;
const dropPov = (ep: RawEpisode, ...ids: string[]) => {
  for (const id of ids) seg(ep, id).scene.characters_present = seg(ep, id).scene.characters_present.filter((c) => c.character_id !== "protagonist");
};
const removeSeg = (ep: RawEpisode, id: string) => {
  ep.segments = ep.segments.filter((s) => s.id !== id);
  ep.segments.forEach((s, i) => (s.order = i + 1));
  ep.chapters = (ep.chapters as { segment_id: string }[]).filter((c) => c.segment_id !== id);
};

describe("full fixture (schema 2.2)", () => {
  it("validates cleanly with a name card, a POV exception and roles on every segment", () => {
    const r = validateEp(episode());
    expect(errors(r)).toBe("");
    expect(warnings(r)).not.toMatch(/Structure:|Viewer identification|name card|names the viewer/);
    expect(r.identification).toMatchObject({ pov_character_id: "protagonist", eligible: 8, on_screen: 8, ratio: 1, enforced: true });
    expect(r.identification!.segments.find((s) => s.segment_id === "seg_009")).toMatchObject({ status: "exception", reason: expect.stringMatching(/door/) });
    expect(r.identification!.segments.find((s) => s.segment_id === "seg_011")!.status).toBe("ineligible");
    expect(r.structure!.applies).toBe(true);
    expect(r.structure!.checks.every((c) => c.ok)).toBe(true);
    expect(r.structure!.roles.map((x) => x.role)).toContain("status_board");
  });

  it("resolves the name card: text from props, the POV character, and a 2 s hold", () => {
    const card = validateEp(episode()).episode!.segments.find((s) => s.id === "seg_name_card")!;
    expect(card.min_duration_sec).toBe(2);
    expect(card.remotion!.props).toMatchObject({ text: "THIS IS YOU", character_id: "protagonist" });
    expect(card.lines).toBeNull();
  });

  it("falls back to identification.name_card.text and the POV character", () => {
    const ep = episode();
    seg(ep, "seg_name_card").remotion!.props = { background: "dark" };
    const r = validateEp(ep);
    expect(errors(r)).toBe("");
    expect(r.episode!.segments.find((s) => s.id === "seg_name_card")!.remotion!.props).toMatchObject({ text: "THIS IS YOU", character_id: "protagonist" });
  });
});

describe("on-screen ratio", () => {
  it("is null with no issue when nothing is eligible", () => {
    const doc = EpisodeDocSchema.parse(episode());
    const cardsOnly = doc.segments.filter((s) => s.type === "title_card" || s.type === "infographic");
    const report = onScreenReport(cardsOnly, "protagonist", { min: 0.8, hard_min: 0.5, enforced: true });
    expect(report).toMatchObject({ eligible: 0, on_screen: 0, ratio: null });
    expect(report.segments.every((s) => s.status === "ineligible")).toBe(true);
  });

  it("warns below min_on_screen_ratio and lists the segments the viewer is missing from", () => {
    const ep = episode();
    dropPov(ep, "seg_003", "seg_006");
    const r = validateEp(ep);
    expect(r.identification!.ratio).toBeCloseTo(6 / 8);
    expect(errors(r)).toBe("");
    expect(warnings(r)).toMatch(/Viewer identification: protagonist is on screen in 6\/8 .*\(75%\).*Missing from: seg_003, seg_006/);
  });

  it("errors below hard_min_on_screen_ratio", () => {
    const ep = episode();
    dropPov(ep, "seg_003", "seg_004", "seg_006", "seg_008");
    const r = validateEp(ep);
    expect(r.identification!.on_screen).toBe(3);
    expect(errors(r)).toMatch(/Viewer identification: .*3\/8 .*at least 50% is required/);
  });

  it("counts reuse_image by the scene it reuses", () => {
    const ep = episode();
    dropPov(ep, "seg_004");
    const r = validateEp(ep);
    expect(r.identification!.segments.find((s) => s.segment_id === "seg_007")!.status).toBe("missing");
    expect(r.identification!.on_screen).toBe(6);
  });

  it("excludes pov_exception_reason segments from the ratio but lists them", () => {
    const ep = episode();
    dropPov(ep, "seg_003", "seg_006");
    seg(ep, "seg_003").scene.pov_exception_reason = "A view of the empty street below.";
    seg(ep, "seg_006").scene.pov_exception_reason = "Close-up of the cans.";
    const r = validateEp(ep);
    expect(r.identification).toMatchObject({ eligible: 6, on_screen: 6, ratio: 1 });
    expect(r.identification!.segments.filter((s) => s.status === "exception").map((s) => s.segment_id)).toEqual(["seg_003", "seg_006", "seg_009"]);
    expect(warnings(r)).not.toMatch(/Viewer identification/);
  });

  it("warns when an exception is declared but the viewer is in the picture", () => {
    const ep = episode();
    seg(ep, "seg_003").scene.pov_exception_reason = "Looking down at the street.";
    expect(warnings(validateEp(ep))).toMatch(/seg_003: pov_exception_reason is set, but protagonist is in the picture/);
  });

  it("replaces the 2.1 per-picture POV warning when identification is on", () => {
    const ep = episode();
    dropPov(ep, "seg_003");
    expect(warnings(validateEp(ep))).not.toMatch(/isn't in this present-day picture/);
  });
});

describe("narrator name lint", () => {
  const named = (forbid = true) => {
    const b = bible();
    b.characters[0].name = "Wick";
    b.characters[0].aliases = ["the Kid"];
    b.narrator.identification!.forbid_narrator_name = forbid;
    return b;
  };

  it("errors on the name, possessives and aliases, whole word and case-insensitive", () => {
    const ep = episode();
    seg(ep, "seg_002").narration = "The morning the city went quiet, Wick's legs carried him to the roof.";
    seg(ep, "seg_003").narration = "From up here, THE KID could see a model town. Nothing moved at all.";
    delete (seg(ep, "seg_003") as { tts_text?: string }).tts_text;
    const e = errors(validateEp(ep, named()));
    expect(e).toMatch(/seg_002: the narrator names the viewer's character \("Wick"\)/);
    expect(e).toMatch(/seg_003: the narrator names the viewer's character \("THE KID"\)/);
  });

  it("ignores names inside longer words and lines spoken by other characters", () => {
    const ep = episode();
    seg(ep, "seg_002").narration = "The morning the city went quiet, you climbed past the Wickham sign to the roof.";
    seg(ep, "seg_010").lines![0] = { ...seg(ep, "seg_010").lines![0], text: "Wick, it's me. Open up before they hear us." };
    const r = validateEp(ep, named());
    expect(errors(r)).not.toMatch(/names the viewer/);
    expect(warnings(r)).not.toMatch(/names the viewer/);
  });

  it("only warns when forbid_narrator_name is false", () => {
    const ep = episode();
    seg(ep, "seg_002").narration = "The morning the city went quiet, Wick climbed to the roof.";
    const r = validateEp(ep, named(false));
    expect(errors(r)).not.toMatch(/names the viewer/);
    expect(warnings(r)).toMatch(/seg_002: the narrator names the viewer's character \("Wick"\)/);
  });

  it("skips pronoun names", () => {
    expect(povNameMatcher(bible(), "protagonist")).toBeNull();
    const b = bible();
    b.characters[0].aliases = ["Wick"];
    expect(povNameMatcher(b, "protagonist")!.names).toEqual(["Wick"]);
  });
});

describe("name card", () => {
  it("warns when the configured episode has none", () => {
    const ep = episode();
    removeSeg(ep, "seg_name_card");
    expect(warnings(validateEp(ep))).toMatch(/Episode 1 should introduce protagonist with one name card/);
  });

  it("errors on a second name card", () => {
    const ep = episode();
    const copy = { ...seg(ep, "seg_name_card"), id: "seg_name_card_2" };
    ep.segments.splice(7, 0, copy);
    ep.segments.forEach((s, i) => (s.order = i + 1));
    expect(errors(validateEp(ep))).toMatch(/seg_name_card_2: only one name card per episode \(the first is seg_name_card\)/);
  });

  it("is not required in other episodes", () => {
    const ep = episode();
    removeSeg(ep, "seg_name_card");
    ep.series.episode_number = 2;
    expect(warnings(validateEp(ep))).not.toMatch(/name card/);
  });

  it("warns when a name card has narration", () => {
    const ep = episode();
    Object.assign(seg(ep, "seg_name_card"), { silent: false, narration: "This is you." });
    expect(warnings(validateEp(ep))).toMatch(/seg_name_card: a name card is a silent hold/);
  });
});

describe("segment roles", () => {
  it("episode 1: cold open first and no recap", () => {
    const ep = episode();
    seg(ep, "seg_001").role = "main";
    seg(ep, "seg_002").role = "recap";
    const w = warnings(validateEp(ep));
    expect(w).toMatch(/Structure: episode 1 should open with a "cold_open" segment/);
    expect(w).toMatch(/Structure: episode 1 has nothing to recap \(seg_002\)/);
  });

  it("episodes 2+: a short recap early on that keeps the POV", () => {
    const ep = episode();
    ep.series.episode_number = 2;
    expect(warnings(validateEp(ep))).toMatch(/Structure: episode 2 should recap the story within its first 3 segments/);

    seg(ep, "seg_002").role = "recap";
    seg(ep, "seg_002").narration = "Last time, I climbed to the roof.";
    const w = warnings(validateEp(ep));
    expect(w).not.toMatch(/should recap/);
    expect(w).toMatch(/Structure: the recap in seg_002 says "I"/);

    seg(ep, "seg_002").narration = Array.from({ length: 6 }, () => "Last time you climbed to the roof and found the city silent.").join(" ");
    expect(warnings(validateEp(ep))).toMatch(/Structure: the recap runs about \d+ s; keep it under 15 s/);
  });

  it("exactly one status board, an infographic, in the first 5", () => {
    const ep = episode();
    seg(ep, "seg_005").role = "main";
    expect(warnings(validateEp(ep))).toMatch(/Structure: add one "status_board" segment/);
    seg(ep, "seg_005").role = "status_board";
    seg(ep, "seg_003").role = "status_board";
    const w = warnings(validateEp(ep));
    expect(w).toMatch(/Structure: exactly one status_board per episode \(found seg_003, seg_005\)/);
    expect(w).toMatch(/Structure: the status board seg_003 should be an infographic/);
  });

  it("a cliffhanger in the last 3 unless it is the finale, and the end card last", () => {
    const ep = episode();
    seg(ep, "seg_012").role = "main";
    seg(ep, "seg_013").role = "main";
    seg(ep, "seg_004").role = "end_card";
    const w = warnings(validateEp(ep));
    expect(w).toMatch(/Structure: mark a "cliffhanger" segment within the last 3/);
    expect(w).toMatch(/Structure: the last segment \(seg_013\) should have role "end_card"/);
    expect(w).toMatch(/Structure: seg_004 is an end_card but isn't the last segment/);
    ep.series.is_finale = true;
    expect(warnings(validateEp(ep))).not.toMatch(/cliffhanger/);
  });

  it("is configurable and skipped for 2.1 episodes", () => {
    const ep = episode();
    seg(ep, "seg_001").role = "main";
    ep.overrides.structure = { cold_open_first: false };
    expect(warnings(validateEp(ep))).not.toMatch(/cold_open/);
    ep.overrides.structure = { enabled: false };
    seg(ep, "seg_013").role = "main";
    expect(warnings(validateEp(ep))).not.toMatch(/Structure:/);

    const old = episode();
    old.schema_version = "2.1";
    old.segments.forEach((s) => delete s.role);
    const r = validateEp(old);
    expect(r.structure!.applies).toBe(false);
    expect(warnings(r)).not.toMatch(/Structure:/);
  });
});

describe("role chapters", () => {
  it("builds chapters from role runs when the episode lists none, merging short runs", () => {
    const doc = EpisodeDocSchema.parse(episode());
    const starts: Record<string, number> = {};
    let t = 0;
    for (const s of [...doc.segments].sort((a, b) => a.order - b.order)) {
      starts[s.id] = t;
      t += s.id === "seg_001" ? 4 : 12;
    }
    const chapters = roleChapters(doc.segments, starts, t, "The Roof");
    expect(chapters[0]).toEqual({ title: "The Roof", start_seconds: 0 });
    expect(chapters.map((c) => c.title)).toEqual(["The Roof", "Status", "The Roof (part 2)", "Cliffhanger", "Next time"]);
    expect(chapters.every((c, i) => i === 0 || c.start_seconds - chapters[i - 1].start_seconds >= 10)).toBe(true);
  });

  it("explicit chapters win in buildChapters", () => {
    const ep = validateEp(episode()).episode!;
    const starts = Object.fromEntries(ep.segments.map((s) => [s.id, (s.order - 1) * 12]));
    expect(buildChapters(ep, starts, 200).map((c) => c.title)).toEqual(["The roof", "Supplies", "The rain", "Mara"]);
    expect(buildChapters({ ...ep, chapters: [] }, starts, 200).map((c) => c.title)).toEqual([
      "Cold open",
      "The Roof",
      "Status",
      "The Roof (part 2)",
      "Cliffhanger",
      "Next time",
    ]);
  });

  it("is empty when every segment is main", () => {
    const doc = EpisodeDocSchema.parse(episode());
    doc.segments.forEach((s) => (s.role = "main"));
    expect(roleChapters(doc.segments, Object.fromEntries(doc.segments.map((s) => [s.id, s.order * 10])), 200, "X")).toEqual([]);
  });
});
