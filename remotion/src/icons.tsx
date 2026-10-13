import React from "react";

/** Flat single-colour pictograms on a 100×100 grid; they inherit `currentColor`. */
const ICONS: Record<string, React.ReactNode> = {
  water_jug: (
    <>
      <rect x="38" y="6" width="24" height="10" rx="3" />
      <path d="M30 22h40l6 10v56a8 8 0 0 1-8 8H32a8 8 0 0 1-8-8V32z" />
      <rect x="34" y="16" width="32" height="8" rx="2" />
    </>
  ),
  can: (
    <>
      <ellipse cx="50" cy="18" rx="26" ry="8" />
      <path d="M24 18v64c0 4.4 11.6 8 26 8s26-3.6 26-8V18c0 4.4-11.6 8-26 8s-26-3.6-26-8z" />
      <rect x="24" y="42" width="52" height="20" opacity="0.35" />
    </>
  ),
  gas_canister: (
    <>
      <path d="M26 24h34l14 14v50a6 6 0 0 1-6 6H32a6 6 0 0 1-6-6z" />
      <rect x="30" y="8" width="18" height="12" rx="3" />
      <path d="M62 10h12v8H62z" />
      <path d="M38 48l24 24M62 48L38 72" stroke="#00000055" strokeWidth="6" />
    </>
  ),
  zombie_head: (
    <>
      <path d="M50 8c-22 0-34 16-34 36 0 14 6 24 14 30v14h40V74c8-6 14-16 14-30C84 24 72 8 50 8z" />
      <circle cx="37" cy="44" r="7" fill="#00000088" />
      <circle cx="63" cy="46" r="5" fill="#00000088" />
      <path d="M36 66h28v6H36z" fill="#00000088" />
      <path d="M42 66v6M50 66v6M58 66v6" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  radio: (
    <>
      <path d="M62 10l12 20" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <rect x="12" y="30" width="76" height="54" rx="8" />
      <circle cx="34" cy="57" r="14" fill="#00000066" />
      <rect x="56" y="44" width="22" height="8" rx="2" fill="#00000066" />
      <rect x="56" y="60" width="22" height="8" rx="2" fill="#00000066" />
    </>
  ),
  pigeon: (
    <>
      <path d="M20 58c0-16 12-28 30-28 6-12 22-14 28-4l10 4-10 4c2 16-8 34-28 38l-6 12h-8l2-12C26 70 20 66 20 58z" />
      <path d="M8 56l20-6-4 14z" />
      <circle cx="72" cy="30" r="3" fill="#00000088" />
    </>
  ),
  kite: (
    <>
      <path d="M50 6l26 34-26 34-26-34z" />
      <path d="M50 74c-4 8 4 10 0 16s4 8 2 4" stroke="currentColor" strokeWidth="3" fill="none" />
      <path d="M50 6v68M24 40h52" stroke="#00000055" strokeWidth="3" />
    </>
  ),
  person: (
    <>
      <circle cx="50" cy="20" r="13" />
      <path d="M30 40h40l6 30h-10l-2 24H36l-2-24H24z" />
    </>
  ),
  medkit: (
    <>
      <rect x="36" y="12" width="28" height="14" rx="4" fill="none" stroke="currentColor" strokeWidth="6" />
      <rect x="8" y="24" width="84" height="64" rx="8" />
      <path d="M44 38h12v12h12v12H56v12H44V62H32V50h12z" fill="#00000077" />
    </>
  ),
  battery: (
    <>
      <rect x="40" y="6" width="20" height="8" rx="2" />
      <rect x="26" y="14" width="48" height="80" rx="8" />
      <path d="M54 30L40 56h12l-6 22 16-30H50z" fill="#00000077" />
    </>
  ),
  flashlight: (
    <>
      <path d="M14 38h40l14-12v48L54 62H14z" />
      <path d="M72 30l20-10v60l-20-10z" opacity="0.45" />
      <rect x="24" y="44" width="10" height="12" fill="#00000066" />
    </>
  ),
  fire: (
    <path d="M50 6c4 18 26 26 26 52 0 20-12 34-26 34S24 78 24 58c0-12 6-20 12-26 0 10 4 16 10 18-2-16 0-30 4-44z" />
  ),
  rope: (
    <>
      <circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" strokeWidth="10" />
      <circle cx="50" cy="50" r="18" fill="none" stroke="currentColor" strokeWidth="8" />
      <path d="M78 70l12 20" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
    </>
  ),
  key: (
    <>
      <circle cx="30" cy="50" r="20" />
      <circle cx="30" cy="50" r="8" fill="#00000077" />
      <path d="M48 44h44v12h-8v12h-10V56h-8v8H56V56h-8z" />
    </>
  ),
  door: (
    <>
      <path d="M22 94V12a4 4 0 0 1 4-4h48a4 4 0 0 1 4 4v82z" />
      <circle cx="66" cy="54" r="5" fill="#00000077" />
      <rect x="10" y="90" width="80" height="6" />
    </>
  ),
  knife: (
    <>
      <path d="M10 62L70 14c6 4 8 12 4 18L28 70z" />
      <rect x="22" y="64" width="16" height="30" rx="4" transform="rotate(-40 30 79)" />
    </>
  ),
  bread: (
    <>
      <path d="M14 46c0-18 16-28 36-28s36 10 36 28c0 6-4 8-8 8v30a6 6 0 0 1-6 6H28a6 6 0 0 1-6-6V54c-4 0-8-2-8-8z" />
      <path d="M38 34l-6 12M52 32l-4 14M66 34l-4 12" stroke="#00000055" strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  bottle: (
    <>
      <rect x="40" y="4" width="20" height="10" rx="2" />
      <path d="M42 14h16v14c10 6 14 14 14 24v38a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6V52c0-10 4-18 14-24z" />
      <rect x="28" y="54" width="44" height="22" opacity="0.4" />
    </>
  ),
  tent: (
    <>
      <path d="M50 10L6 88h88z" />
      <path d="M50 40L34 88h32z" fill="#00000077" />
      <path d="M46 4l8 12" stroke="currentColor" strokeWidth="4" />
    </>
  ),
  sun: (
    <>
      <circle cx="50" cy="50" r="20" />
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x="47" y="4" width="6" height="16" rx="3" transform={`rotate(${i * 45} 50 50)`} />
      ))}
    </>
  ),
  moon: <path d="M62 8a40 40 0 1 0 30 58A32 32 0 0 1 62 8z" />,
  skull: (
    <>
      <path d="M50 6C28 6 14 22 14 42c0 12 6 22 14 26v18h44V68c8-4 14-14 14-26C86 22 72 6 50 6z" />
      <circle cx="36" cy="44" r="9" fill="#00000088" />
      <circle cx="64" cy="44" r="9" fill="#00000088" />
      <path d="M46 62l4-8 4 8z" fill="#00000088" />
      <path d="M40 76v10M50 76v10M60 76v10" stroke="#00000088" strokeWidth="4" />
    </>
  ),
  heart: <path d="M50 88L14 52C2 40 6 18 24 14c10-2 20 2 26 12 6-10 16-14 26-12 18 4 22 26 10 38z" />,
  house: (
    <>
      <path d="M50 8L6 46h12v46h64V46h12z" />
      <rect x="42" y="60" width="16" height="32" fill="#00000077" />
    </>
  ),
};

export const ICON_NAMES = Object.keys(ICONS);

export const Icon: React.FC<{ name: string | null | undefined; size: number; color: string; style?: React.CSSProperties }> = ({
  name,
  size,
  color,
  style,
}) => {
  const glyph = name ? ICONS[name] : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ color, fill: "currentColor", ...style }}>
      {glyph ?? (
        <>
          <circle cx="50" cy="50" r="42" />
          <text x="50" y="66" textAnchor="middle" fontSize="44" fontFamily="Inter" fontWeight="800" fill="#00000088">
            {(name ?? "?").charAt(0).toUpperCase()}
          </text>
        </>
      )}
    </svg>
  );
};
