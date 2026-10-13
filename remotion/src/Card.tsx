import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { Icon } from "./icons";
import { accentColor, BODY_FONT, COLORS, DISPLAY_FONT, fitFontSize, palette, type Accent, type Background } from "./theme";

export interface CardItem {
  label: string;
  value?: string | null;
  icon?: string | null;
  icon_count?: number | null;
  icon_total?: number | null;
}

export interface CardProps {
  template: "title_card" | "supplies_card" | "pictogram_chart" | "statement_card" | "lower_third" | "custom";
  title?: string | null;
  subtitle?: string | null;
  body?: string | null;
  background?: Background;
  /** Signed URL of the segment image used when background === "image". */
  backgroundImageUrl?: string | null;
  items?: CardItem[];
  footer?: string | null;
  accent?: Accent;
}

const W = 1920;

const Backdrop: React.FC<{ background: Background; imageUrl?: string | null; dim?: number }> = ({ background, imageUrl, dim = 0.55 }) => {
  const p = palette(background);
  if (background === "image" && imageUrl) {
    return (
      <AbsoluteFill>
        <Img src={imageUrl} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        <AbsoluteFill style={{ background: `rgba(20,23,28,${dim})` }} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ background: p.bg }}>
      {/* faint paper grain so flat colour does not band after video compression */}
      <AbsoluteFill
        style={{
          backgroundImage:
            background === "cream"
              ? "radial-gradient(rgba(20,23,28,0.05) 1px, transparent 1px)"
              : "radial-gradient(rgba(243,239,230,0.04) 1px, transparent 1px)",
          backgroundSize: "6px 6px",
        }}
      />
    </AbsoluteFill>
  );
};

const Title: React.FC<{ text: string; color: string; max: number; width?: number; align?: "center" | "left" }> = ({
  text,
  color,
  max,
  width = W - 240,
  align = "center",
}) => (
  <div
    style={{
      fontFamily: DISPLAY_FONT,
      fontSize: fitFontSize(text, max, width, 0.48),
      lineHeight: 1.05,
      color,
      textTransform: "uppercase",
      letterSpacing: 2,
      textAlign: align,
    }}
  >
    {text}
  </div>
);

const Footer: React.FC<{ text?: string | null; color: string }> = ({ text, color }) =>
  text ? (
    <div style={{ position: "absolute", bottom: 56, left: 0, right: 0, textAlign: "center", fontFamily: BODY_FONT, fontSize: 32, color }}>
      {text}
    </div>
  ) : null;

function TitleCard(p: CardProps) {
  const bg = p.background ?? "dark";
  const c = palette(bg === "image" ? "dark" : bg);
  const accent = accentColor(p.accent ?? "red", c.fg);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: 120 }}>
      <Title text={p.title ?? ""} color={c.fg} max={260} />
      {p.subtitle && (
        <div style={{ marginTop: 28, fontFamily: BODY_FONT, fontWeight: 600, fontSize: 52, color: c.sub, textAlign: "center" }}>
          {p.subtitle}
        </div>
      )}
      {(p.accent ?? "red") !== "none" && <div style={{ marginTop: 40, width: 180, height: 10, background: accent, borderRadius: 5 }} />}
      <Footer text={p.footer} color={c.sub} />
    </AbsoluteFill>
  );
}

function SuppliesCard(p: CardProps) {
  const bg = p.background ?? "cream";
  const c = palette(bg === "image" ? "dark" : bg);
  const accent = accentColor(p.accent ?? "red", c.fg);
  const items = (p.items ?? []).slice(0, 6);
  const rowH = Math.min(150, Math.floor(620 / Math.max(1, items.length)));
  return (
    <AbsoluteFill style={{ padding: "90px 140px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 32 }}>
        <Title text={p.title ?? "SUPPLIES"} color={c.fg} max={150} width={1100} align="left" />
        {p.subtitle && <div style={{ fontFamily: BODY_FONT, fontWeight: 800, fontSize: 44, color: accent }}>{p.subtitle}</div>}
      </div>
      <div style={{ height: 8, background: accent, width: 220, margin: "18px 0 40px", borderRadius: 4 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {items.map((item, i) => {
          const total = Math.max(1, Math.min(10, item.icon_total ?? item.icon_count ?? 1));
          const have = Math.max(0, Math.min(total, item.icon_count ?? total));
          const low = have / total <= 0.25;
          const iconSize = Math.min(rowH - 20, 96);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", height: rowH, gap: 36 }}>
              <div style={{ width: 360, fontFamily: BODY_FONT, fontWeight: 800, fontSize: Math.min(56, rowH * 0.45), color: c.fg }}>
                {item.label}
              </div>
              <div style={{ display: "flex", gap: 14, flex: 1 }}>
                {Array.from({ length: total }, (_, k) => (
                  <Icon key={k} name={item.icon} size={iconSize} color={k < have ? (low ? COLORS.red : c.fg) : c.faded} />
                ))}
              </div>
              {item.value && (
                <div
                  style={{
                    minWidth: 260,
                    textAlign: "right",
                    fontFamily: DISPLAY_FONT,
                    fontSize: Math.min(64, rowH * 0.5),
                    color: low ? COLORS.red : c.fg,
                  }}
                >
                  {item.value}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Footer text={p.footer} color={c.sub} />
    </AbsoluteFill>
  );
}

function PictogramChart(p: CardProps) {
  const bg = p.background ?? "cream";
  const c = palette(bg === "image" ? "dark" : bg);
  const accent = accentColor(p.accent ?? "red", c.fg);
  const items = (p.items ?? []).slice(0, 4);
  return (
    <AbsoluteFill style={{ padding: "90px 120px", alignItems: "center" }}>
      <Title text={p.title ?? ""} color={c.fg} max={140} />
      {p.subtitle && <div style={{ fontFamily: BODY_FONT, fontWeight: 600, fontSize: 40, color: c.sub, marginTop: 12 }}>{p.subtitle}</div>}
      <div style={{ display: "flex", gap: 80, marginTop: 70, flex: 1, alignItems: "center", justifyContent: "center", width: "100%" }}>
        {items.map((item, i) => {
          const total = Math.max(1, Math.min(20, item.icon_total ?? item.icon_count ?? 1));
          const have = Math.max(0, Math.min(total, item.icon_count ?? total));
          const perRow = total <= 5 ? total : Math.ceil(total / 2);
          const size = Math.min(130, Math.floor(1500 / items.length / perRow) - 12);
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${perRow}, ${size}px)`, gap: 12 }}>
                {Array.from({ length: total }, (_, k) => (
                  <Icon key={k} name={item.icon} size={size} color={k < have ? (i === 0 ? accent : c.fg) : c.faded} />
                ))}
              </div>
              {item.value && <div style={{ fontFamily: DISPLAY_FONT, fontSize: 84, color: i === 0 ? accent : c.fg }}>{item.value}</div>}
              <div style={{ fontFamily: BODY_FONT, fontWeight: 800, fontSize: 40, color: c.fg, textTransform: "uppercase" }}>{item.label}</div>
            </div>
          );
        })}
      </div>
      <Footer text={p.footer} color={c.sub} />
    </AbsoluteFill>
  );
}

function StatementCard(p: CardProps) {
  const bg = p.background ?? "dark";
  const c = palette(bg === "image" ? "dark" : bg);
  const accent = accentColor(p.accent ?? "red", c.fg);
  const text = p.body ?? p.title ?? "";
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 200px" }}>
      {p.title && p.body && (
        <div style={{ fontFamily: BODY_FONT, fontWeight: 800, fontSize: 40, color: accent, letterSpacing: 6, marginBottom: 30, textTransform: "uppercase" }}>
          {p.title}
        </div>
      )}
      <div
        style={{
          fontFamily: BODY_FONT,
          fontWeight: 800,
          fontSize: fitFontSize(text, 110, 1520, 0.55, 4),
          lineHeight: 1.2,
          color: c.fg,
          textAlign: "center",
        }}
      >
        {text}
      </div>
      {p.subtitle && <div style={{ marginTop: 30, fontFamily: BODY_FONT, fontSize: 40, color: c.sub }}>{p.subtitle}</div>}
      <Footer text={p.footer} color={c.sub} />
    </AbsoluteFill>
  );
}

function LowerThird(p: CardProps) {
  const accent = accentColor(p.accent ?? "red", COLORS.red);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 100, bottom: 110, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ background: accent, color: COLORS.paper, fontFamily: DISPLAY_FONT, fontSize: 84, padding: "10px 34px", textTransform: "uppercase", letterSpacing: 2 }}>
          {p.title ?? ""}
        </div>
        {p.subtitle && (
          <div style={{ background: COLORS.dark, color: COLORS.paper, fontFamily: BODY_FONT, fontWeight: 600, fontSize: 44, padding: "12px 34px" }}>
            {p.subtitle}
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
}

function CustomCard(p: CardProps) {
  const bg = p.background ?? "dark";
  const c = palette(bg === "image" ? "dark" : bg);
  const accent = accentColor(p.accent ?? "red", c.fg);
  return (
    <AbsoluteFill style={{ padding: "100px 160px", justifyContent: "center" }}>
      {p.title && <Title text={p.title} color={c.fg} max={150} align="left" />}
      {p.subtitle && <div style={{ fontFamily: BODY_FONT, fontWeight: 600, fontSize: 46, color: accent, marginTop: 10 }}>{p.subtitle}</div>}
      {p.body && <div style={{ fontFamily: BODY_FONT, fontSize: 48, lineHeight: 1.35, color: c.fg, marginTop: 40, maxWidth: 1500 }}>{p.body}</div>}
      {(p.items ?? []).length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 40 }}>
          {(p.items ?? []).slice(0, 6).map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, fontFamily: BODY_FONT, fontSize: 46, color: c.fg }}>
              {item.icon ? <Icon name={item.icon} size={64} color={accent} /> : <span style={{ color: accent }}>●</span>}
              <span style={{ fontWeight: 800 }}>{item.label}</span>
              {item.value && <span style={{ color: c.sub }}>{item.value}</span>}
            </div>
          ))}
        </div>
      )}
      <Footer text={p.footer} color={c.sub} />
    </AbsoluteFill>
  );
}

export const Card: React.FC<CardProps> = (props) => {
  const background = props.background ?? (props.template === "supplies_card" || props.template === "pictogram_chart" ? "cream" : "dark");
  const p = { ...props, background };
  const body = {
    title_card: TitleCard,
    supplies_card: SuppliesCard,
    pictogram_chart: PictogramChart,
    statement_card: StatementCard,
    lower_third: LowerThird,
    custom: CustomCard,
  }[props.template] ?? CustomCard;
  const dim = props.template === "lower_third" ? 0 : 0.6;
  return (
    <AbsoluteFill>
      <Backdrop background={background} imageUrl={props.backgroundImageUrl} dim={dim} />
      {body(p)}
    </AbsoluteFill>
  );
};
