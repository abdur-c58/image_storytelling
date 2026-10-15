import { RenderSchema, VoiceSchema, type Episode } from "./schema";

export type SettingSource = "episode" | "story" | "default";

export interface EffectiveSetting {
  key: string;
  value: unknown;
  source: SettingSource;
}

/** Voice fields the voice stage and the timeline act on, in display order. */
export const VOICE_KEYS = [
  "speed",
  "pause_between_sentences_ms",
  "pause_between_segments_ms",
  "narrator_to_dialogue_gap_ms",
  "dialogue_reply_gap_ms",
  "pause_durations_ms",
  "tag_whitelist",
  "max_tags_per_100_words",
  "tag_fallback_mode",
  "trim_silence",
  "trim_threshold_db",
  "keep_head_ms",
  "keep_tail_ms",
] as const;

export const RENDER_KEYS = ["image_lead_ms", "max_silence_ms"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function rows(
  keys: readonly string[],
  effective: Record<string, unknown>,
  defaults: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): EffectiveSetting[] {
  return keys.map((key) => {
    const value = effective[key];
    const source: SettingSource =
      override && override[key] !== undefined && override[key] !== null ? "episode" : same(value, defaults[key]) ? "default" : "story";
    return { key, value, source };
  });
}

/**
 * The voice and pacing settings an episode version actually runs with, and where each came from: the episode's
 * `overrides`, the story's `defaults`, or the built-in default. Episodes stored before a field existed get its default.
 */
export function effectiveSettings(ep: Episode): { voice: EffectiveSetting[]; render: EffectiveSetting[] } {
  const voice = VoiceSchema.parse(ep.voice ?? {}) as Record<string, unknown>;
  const render = RenderSchema.parse(ep.render ?? {}) as Record<string, unknown>;
  const o = (ep.overrides ?? {}) as { voice?: Record<string, unknown>; render?: Record<string, unknown> };
  return {
    voice: rows(VOICE_KEYS, voice, VoiceSchema.parse({}) as Record<string, unknown>, o.voice),
    render: rows(RENDER_KEYS, render, RenderSchema.parse({}) as Record<string, unknown>, o.render),
  };
}
