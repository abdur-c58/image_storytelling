import React from "react";
import { AbsoluteFill, Composition, Still } from "remotion";
import { Card, type CardProps } from "./Card";
import { Icon, ICON_NAMES } from "./icons";
import { BODY_FONT, COLORS } from "./theme";
import { Thumbnail, type ThumbnailProps } from "./Thumbnail";
import "./theme";

const sampleCard: CardProps = {
  template: "supplies_card",
  title: "SUPPLIES",
  subtitle: "DAY 12",
  background: "cream",
  items: [
    { label: "Water", value: "5,000 gal", icon: "water_jug", icon_count: 5, icon_total: 5 },
    { label: "Food", value: "2 days", icon: "can", icon_count: 1, icon_total: 5 },
    { label: "Fuel", value: "half", icon: "gas_canister", icon_count: 2, icon_total: 4 },
  ],
  accent: "red",
};

const sampleThumb: ThumbnailProps = {
  baseImageUrl: null,
  textLayers: [
    { text: "DAY 1", style: "impact_white_black_outline", position: "top_center", max_font_size_px: 220 },
    { text: "FLOOR 30", style: "red_badge", position: "left_middle" },
  ],
};

/** Every icon on one sheet, for checking the library visually. */
const IconSheet: React.FC = () => (
  <AbsoluteFill style={{ background: COLORS.cream, padding: 60, display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 30 }}>
    {[...ICON_NAMES, "unknown_icon"].map((name) => (
      <div key={name} style={{ display: "flex", flexDirection: "column", alignItems: "center", fontFamily: BODY_FONT, fontSize: 20, color: COLORS.ink }}>
        <Icon name={name} size={150} color={COLORS.ink} />
        {name}
      </div>
    ))}
  </AbsoluteFill>
);

type AnyFC = React.FC<Record<string, unknown>>;

/** Remotion merges defaultProps into input props, so render targets get empty defaults; samples live in *Preview. */
export const RemotionRoot: React.FC = () => (
  <>
    <Still id="Card" component={Card as unknown as AnyFC} width={1920} height={1080} defaultProps={{ template: "custom" }} />
    <Still id="Thumbnail" component={Thumbnail as unknown as AnyFC} width={1280} height={720} defaultProps={{ baseImageUrl: null, textLayers: [] }} />
    <Still id="CardPreview" component={Card as unknown as AnyFC} width={1920} height={1080} defaultProps={sampleCard as unknown as Record<string, unknown>} />
    <Still id="ThumbnailPreview" component={Thumbnail as unknown as AnyFC} width={1280} height={720} defaultProps={sampleThumb as unknown as Record<string, unknown>} />
    <Still id="IconSheet" component={IconSheet} width={1920} height={1080} />
    <Composition id="CardMotionPreview" component={Card as unknown as AnyFC} durationInFrames={90} fps={30} width={1920} height={1080} defaultProps={sampleCard as unknown as Record<string, unknown>} />
  </>
);
