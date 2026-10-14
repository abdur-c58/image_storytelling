import { NARRATOR } from "./constants";
import type { Line } from "./schema";

type SegmentLike = {
  id: string;
  silent: boolean;
  narration: string;
  tts_text: string | null;
  caption_text?: string | null;
  lines?: Line[] | null;
};

/**
 * The lines a segment speaks. `narration` (+ `tts_text`) is one narrator line, so everything downstream can
 * read lines only. Silent segments speak nothing.
 */
export function segmentLines(seg: SegmentLike): Line[] {
  if (seg.silent) return [];
  if (seg.lines?.length) return seg.lines;
  if (!seg.narration.trim()) return [];
  return [
    {
      id: `${seg.id}_l1`,
      speaker: NARRATOR,
      text: seg.narration,
      tts_text: seg.tts_text,
      voice_effect: "none",
      on_screen: false,
      source: "spoken",
      caption_text: seg.caption_text ?? null,
    },
  ];
}

/** Clean spoken text of a segment (all lines joined). */
export function segmentText(seg: SegmentLike): string {
  return segmentLines(seg)
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join(" ");
}

/** Whether a line's speaker is visible in frame (the narrator never is). */
export function lineOnScreen(line: Pick<Line, "speaker" | "on_screen">): boolean {
  return line.speaker !== NARRATOR && line.on_screen;
}
