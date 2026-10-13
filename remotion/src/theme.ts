import { loadFont } from "@remotion/fonts";
import anton400 from "@fontsource/anton/files/anton-latin-400-normal.woff2";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2";
import inter800 from "@fontsource/inter/files/inter-latin-800-normal.woff2";

export const COLORS = {
  dark: "#14171c",
  cream: "#f3efe6",
  ink: "#14171c",
  paper: "#f3efe6",
  red: "#d64541",
  blue: "#3b7dd8",
  muted: "#8a8f98",
  faded: "rgba(20,23,28,0.18)",
  fadedLight: "rgba(243,239,230,0.22)",
};

export const DISPLAY_FONT = "Anton";
export const BODY_FONT = "Inter";

// Fonts ship inside the bundle (Fontsource, SIL OFL), so rendering never depends on Google Fonts being reachable.
void Promise.all([
  loadFont({ family: DISPLAY_FONT, url: anton400, weight: "400" }),
  loadFont({ family: BODY_FONT, url: inter400, weight: "400" }),
  loadFont({ family: BODY_FONT, url: inter600, weight: "600" }),
  loadFont({ family: BODY_FONT, url: inter800, weight: "800" }),
]);

export type Background = "dark" | "cream" | "image";
export type Accent = "red" | "blue" | "none";

export function palette(background: Background) {
  const light = background === "cream";
  return {
    bg: light ? COLORS.cream : COLORS.dark,
    fg: light ? COLORS.ink : COLORS.paper,
    sub: light ? "rgba(20,23,28,0.62)" : "rgba(243,239,230,0.72)",
    faded: light ? COLORS.faded : COLORS.fadedLight,
  };
}

export function accentColor(accent: Accent, fallback: string): string {
  return accent === "red" ? COLORS.red : accent === "blue" ? COLORS.blue : fallback;
}

/** Shrink display text so long titles fit on one or two lines. */
export function fitFontSize(text: string, maxPx: number, widthPx: number, charWidthEm = 0.5, maxLines = 2): number {
  const chars = Math.max(1, text.length);
  const perLine = Math.ceil(chars / maxLines);
  return Math.max(28, Math.min(maxPx, Math.floor(widthPx / (perLine * charWidthEm))));
}
