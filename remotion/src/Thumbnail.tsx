import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { COLORS, DISPLAY_FONT, fitFontSize } from "./theme";

export interface TextLayer {
  text: string;
  style: "impact_white_black_outline" | "impact_yellow_black_outline" | "red_badge" | "plain_white";
  position: "top_left" | "top_center" | "top_right" | "left_middle" | "center" | "right_middle" | "bottom_left" | "bottom_center" | "bottom_right";
  max_font_size_px?: number;
}

export interface ThumbnailProps {
  baseImageUrl: string | null;
  textLayers: TextLayer[];
}

const W = 1280;
const H = 720;
const MARGIN = 44;

function placement(position: TextLayer["position"]): React.CSSProperties {
  const [v, h] = position === "center" ? ["middle", "center"] : position.split("_");
  const css: React.CSSProperties = { position: "absolute", display: "flex", maxWidth: W * 0.62 };
  if (v === "top") css.top = MARGIN;
  else if (v === "bottom") css.bottom = MARGIN;
  else if (v === "left" || v === "right" || v === "middle") {
    css.top = "50%";
    css.transform = "translateY(-50%)";
  }
  const horizontal = v === "left" || v === "right" ? v : h;
  if (horizontal === "left") css.left = MARGIN;
  else if (horizontal === "right") css.right = MARGIN;
  else {
    css.left = "50%";
    css.transform = `${css.transform ?? ""} translateX(-50%)`.trim();
    css.maxWidth = W - MARGIN * 2;
  }
  if (position === "center") css.transform = "translate(-50%, -50%)";
  return css;
}

/** Thick outline via layered text-shadows (works for any font, unlike -webkit-text-stroke on Anton). */
function outline(px: number, color: string): string {
  const shadows: string[] = [];
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    shadows.push(`${(Math.cos(a) * px).toFixed(1)}px ${(Math.sin(a) * px).toFixed(1)}px 0 ${color}`);
  }
  shadows.push(`0 ${px * 0.9}px ${px * 1.6}px rgba(0,0,0,0.55)`);
  return shadows.join(",");
}

const Layer: React.FC<{ layer: TextLayer }> = ({ layer }) => {
  const max = Math.min(layer.max_font_size_px ?? 200, 240) * (W / 1920) * 1.5;
  const size = fitFontSize(layer.text, max, layer.position.endsWith("center") ? W - MARGIN * 2 : W * 0.6, 0.46, layer.text.length > 14 ? 2 : 1);
  const base: React.CSSProperties = {
    fontFamily: DISPLAY_FONT,
    fontSize: size,
    lineHeight: 1.02,
    textTransform: "uppercase",
    letterSpacing: 1,
    textAlign: layer.position.endsWith("right") ? "right" : layer.position.endsWith("left") ? "left" : "center",
  };
  switch (layer.style) {
    case "red_badge":
      return (
        <div style={placement(layer.position)}>
          <div
            style={{
              ...base,
              fontSize: size * 0.72,
              color: "#fff",
              background: COLORS.red,
              padding: `${size * 0.08}px ${size * 0.24}px`,
              borderRadius: size * 0.1,
              border: `${Math.max(4, size * 0.05)}px solid #fff`,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              transform: "rotate(-3deg)",
            }}
          >
            {layer.text}
          </div>
        </div>
      );
    case "plain_white":
      return (
        <div style={placement(layer.position)}>
          <div style={{ ...base, color: "#fff", textShadow: "0 4px 18px rgba(0,0,0,0.85)" }}>{layer.text}</div>
        </div>
      );
    default: {
      const fill = layer.style === "impact_yellow_black_outline" ? "#ffd400" : "#ffffff";
      return (
        <div style={placement(layer.position)}>
          <div style={{ ...base, color: fill, textShadow: outline(Math.max(4, size * 0.07), "#000") }}>{layer.text}</div>
        </div>
      );
    }
  }
};

export const Thumbnail: React.FC<ThumbnailProps> = ({ baseImageUrl, textLayers }) => (
  <AbsoluteFill style={{ background: COLORS.dark }}>
    {baseImageUrl && <Img src={baseImageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
    {/* slight vignette keeps outlined text readable on busy art */}
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.35) 100%)" }} />
    {textLayers.map((layer, i) => (
      <Layer key={i} layer={layer} />
    ))}
  </AbsoluteFill>
);
