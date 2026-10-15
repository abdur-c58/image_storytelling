import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = "pglite:memory://";
process.env.LOCAL_STORAGE_DIR = path.join(".data", "test-storage-pacing");

import { createAsset, readyAssetMap } from "@/lib/assets";
import { getDb, type Db } from "@/lib/db";
import { storyMasters, taskEvents, tasks } from "@/lib/db/schema";
import { effectiveSettings } from "@/lib/episode/effective";
import { StoredStoryBibleSchema, type StoryBible } from "@/lib/episode/schema";
import type { ImageItem } from "@/lib/episode/prompt";
import { validateDocument, type StoryContext } from "@/lib/episode/validate";
import { advance } from "@/lib/pipeline/advance";
import { ingestDocument } from "@/lib/pipeline/ingest";
import { assetKeys, requirements } from "@/lib/pipeline/requirements";
import { unchangedSegments } from "@/lib/pipeline/reuse";
import { getStorage } from "@/lib/storage";

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
const json = (name: string): Raw => JSON.parse(fixture(name));
const bible = (mutate?: (b: Raw) => void): StoryBible => {
  const b = json("story_bible_example.json");
  mutate?.(b);
  return StoredStoryBibleSchema.parse(b);
};
const NOW = new Date("2026-10-12T00:00:00Z");
const validateEp = (obj: unknown, b: StoryBible = bible()) => validateDocument(obj, { now: NOW, story: { bible: b, state: null } as StoryContext });
const byOrder = (ep: Raw) => [...ep.segments].sort((a: Raw, b: Raw) => a.order - b.order);

describe("effective voice settings", () => {
  it("marks each value as episode override, story default or built-in default", () => {
    const raw = json("episode_full.json");
    raw.overrides.voice = { ...raw.overrides.voice, speed: 1.1, keep_tail_ms: 120, tag_whitelist: ["sighs"], max_tags_per_100_words: 3 };
    raw.overrides.render = { image_lead_ms: 80 };
    const b = bible((x) => {
      x.defaults.voice = { ...x.defaults.voice, keep_head_ms: 25, pause_between_segments_ms: 600 };
    });
    const r = validateEp(raw, b);
    expect(r.errors).toEqual([]);
    const ep = r.episode!;
    expect(ep.voice).toMatchObject({ speed: 1.1, keep_tail_ms: 120, keep_head_ms: 25, trim_silence: true, trim_threshold_db: -50 });
    const { voice, render } = effectiveSettings(ep);
    const source = Object.fromEntries(voice.map((s) => [s.key, s.source]));
    expect(source).toMatchObject({
      speed: "episode",
      keep_tail_ms: "episode",
      tag_whitelist: "episode",
      max_tags_per_100_words: "episode",
      keep_head_ms: "story",
      pause_between_segments_ms: "story",
      trim_silence: "default",
      trim_threshold_db: "default",
    });
    expect(render).toEqual([
      { key: "image_lead_ms", value: 80, source: "episode" },
      { key: "max_silence_ms", value: 700, source: "default" },
    ]);
  });

  it("an episode speed override beats the story narrator's own speed", () => {
    const b = bible((x) => {
      x.narrator.voice = { voice_id: "narrator-voice", speed: 0.9 };
    });
    const raw = json("episode_full.json");
    expect(validateEp(raw, b).episode!.voices.narrator.speed).toBe(0.9);
    raw.overrides.voice = { speed: 1.2 };
    const ep = validateEp(raw, b).episode!;
    expect(ep.voices.narrator.speed).toBe(1.2);
    expect(ep.voices.narrator.voice_id).toBe("narrator-voice");
  });
});

describe("sound beds", () => {
  it("accepts a bed across consecutive segments and warns on restarts and duplicates", () => {
    const raw = json("episode_full.json");
    const segs = byOrder(raw);
    const template = segs.flatMap((s: Raw) => s.sfx ?? [])[0];
    const add = (i: number, suffix: string) => {
      segs[i].sfx = [...(segs[i].sfx ?? []), { ...template, id: `${segs[i].id}_sfx_${suffix}`, placement: "whole_segment", at_phrase: null, bed_id: "hum" }];
    };
    add(2, "bed");
    add(3, "bed");
    let r = validateEp(raw);
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.path_text.endsWith("bed_id"))).toEqual([]);
    expect(r.episode!.segments.find((s) => s.id === segs[2].id)!.sfx.at(-1)!.bed_id).toBe("hum");

    add(3, "bed2");
    add(6, "bed");
    r = validateEp(raw);
    const bedWarnings = r.warnings.filter((w) => w.path_text.endsWith("bed_id")).map((w) => w.message);
    expect(bedWarnings).toHaveLength(2);
    expect(bedWarnings[0]).toMatch(/already has a cue in this segment/);
    expect(bedWarnings[1]).toMatch(/restarts here as a separate bed/);
  });

  it("cues without bed_id default to null", () => {
    const ep = validateEp(json("episode_full.json")).episode!;
    expect(ep.segments.flatMap((s) => s.sfx).every((c) => c.bed_id === null)).toBe(true);
  });
});

describe("image reuse across versions", () => {
  it("only matches the same segment with the same final and negative prompt", () => {
    const prev = [
      { segmentId: "a", finalPrompt: "red door", negativePrompt: null },
      { segmentId: "b", finalPrompt: "blue sky", negativePrompt: "text" },
      { segmentId: "c", finalPrompt: "cat", negativePrompt: "" },
      { segmentId: "d", finalPrompt: null, negativePrompt: null },
    ];
    const next = [
      { segmentId: "a", finalPrompt: "red door", negativePrompt: "" },
      { segmentId: "b", finalPrompt: "blue sky", negativePrompt: "blurry" },
      { segmentId: "c", finalPrompt: "a cat", negativePrompt: "" },
      { segmentId: "d", finalPrompt: null, negativePrompt: null },
      { segmentId: "e", finalPrompt: "red door", negativePrompt: null },
    ];
    expect(unchangedSegments(next, prev)).toEqual(["a"]);
  });

  describe("with a database", () => {
    let db: Db;
    beforeAll(async () => {
      db = await getDb();
      const b = json("story_bible_example.json");
      b.automation.approval_gates.location_masters = false;
      const out = await ingestDocument(db, JSON.stringify(b));
      expect(out.error).toBeNull();
    });

    it("copies unchanged images into the new version and queues only the changed segment", async () => {
      const v1Raw = json("episode_full.json");
      v1Raw.automation = { ...v1Raw.automation, auto_start_on_submit: false };
      const v1 = await ingestDocument(db, JSON.stringify(v1Raw));
      expect(v1.error).toBeNull();
      const v1Id = v1.projectId!;
      const images = requirements(validateEp(v1Raw).episode!).images;
      expect(images.length).toBeGreaterThan(2);
      const storage = getStorage();
      for (const id of images) {
        const a = await createAsset(db, { projectId: v1Id, taskId: null, assetKey: assetKeys.image(id), contentType: "image/png", status: "ready", width: 2560, height: 1440 });
        await storage.put(a.storageKey, new TextEncoder().encode(`png ${id}`), "image/png");
      }

      const changed = images[1];
      const v2Raw = json("episode_full.json");
      const seg = v2Raw.segments.find((s: Raw) => s.id === changed);
      seg.image.prompt = `${seg.image.prompt}, now at dusk`;
      const v2 = await ingestDocument(db, JSON.stringify(v2Raw));
      expect(v2.error).toBeNull();
      const v2Id = v2.projectId!;

      const mine = await readyAssetMap(db, v2Id);
      for (const id of images) {
        const a = mine.get(assetKeys.image(id));
        if (id === changed) {
          expect(a).toBeUndefined();
          continue;
        }
        expect(a?.storageKey).not.toContain(v1Id);
        expect((a!.meta as Raw).reused_from).toMatchObject({ project_id: v1Id, version: 1 });
        expect(new TextDecoder().decode(await storage.get(a!.storageKey))).toBe(`png ${id}`);
      }
      const log = await db.select().from(taskEvents).where(eq(taskEvents.projectId, v2Id));
      expect(log.map((e) => e.message).join("\n")).toMatch(new RegExp(`Reused ${images.length - 1} unchanged image\\(s\\) from v1; 1 segment\\(s\\) need a new image \\(${changed}\\)`));

      await db.update(storyMasters).set({ status: "approved" }).where(eq(storyMasters.storyId, "rooftop-test"));
      await advance(db, v2Id);
      const imageTasks = await db.select().from(tasks).where(and(eq(tasks.projectId, v2Id), eq(tasks.type, "generate_images")));
      const items = imageTasks.flatMap((t) => (t.payload as { items: ImageItem[] }).items.map((i) => i.segment_id));
      expect(items.filter((id) => id !== "thumbnail")).toEqual([changed]);
    });
  });
});
