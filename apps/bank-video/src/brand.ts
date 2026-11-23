import type { CSSProperties } from "react";

import type { Kind } from "./records";

/** The landing page's palette, so the film and the page read as one product. */
export const color = {
  ground: "#2a2a27",
  rule: "#5c5c54",
  ruleSoft: "#45453f",
  ink: "#ece8dc",
  dim: "#c4c0b0",
  faint: "#a5a18d",
  paper: "#cfc9b8",
  print: "#3b3a35",
} as const;

export const kindColor = {
  mail: "#dcc58c",
  chat: "#a5c39c",
  ai: "#c0add9",
  library: "#d9a593",
  drives: "#95b4d4",
} satisfies Record<Kind, string>;

export const kinds: Kind[] = ["mail", "chat", "ai", "library", "drives"];

/**
 * The fixed frame every shot is composed in: an editor's bracket around a cited passage, half
 * the screen in each direction and centred. Its corners never move until the finale, when they
 * close into the logo.
 */
export const frame = { left: 480, top: 270, right: 1440, bottom: 810, arm: 44 } as const;
export const centre = { x: 960, y: 540 } as const;
export const frameWidth = frame.right - frame.left;
export const frameHeight = frame.bottom - frame.top;

const monoFamily = '"Martian Mono Variable", ui-monospace, Consolas, monospace';
const serifFamily = '"Source Serif 4 Variable", Georgia, serif';

export const mono: CSSProperties = {
  fontFamily: monoFamily,
  fontVariationSettings: '"wdth" 88',
  fontFeatureSettings: '"zero" 0',
};

export const display: CSSProperties = {
  fontFamily: monoFamily,
  fontVariationSettings: '"wdth" 80',
  fontWeight: 500,
  letterSpacing: "-0.035em",
};

export const serif: CSSProperties = {
  fontFamily: serifFamily,
  fontOpticalSizing: "auto",
};

/** Bright type blooms a little, like a phosphor screen. */
export const glow = (strength = 1): CSSProperties => ({
  textShadow: `0 0 ${1.2 * strength}em color-mix(in srgb, currentColor ${30 * strength}%, transparent), 0 0 0.3em color-mix(in srgb, currentColor ${22 * strength}%, transparent)`,
});

export const lineGlow: CSSProperties = { filter: "drop-shadow(0 0 3px rgb(236 232 220 / 0.55))" };
