import type { CoverMaterial } from "@/domain/element";

export const COVER_MATERIALS = [
  "linen",
  "leather",
  "cloth",
] as const satisfies readonly CoverMaterial[];

/** The six cover swatches. Values are the album's `cover.color`. */
export const COVER_COLORS = {
  oxblood: "oklch(0.36 0.09 22)",
  forest: "oklch(0.42 0.06 152)",
  navy: "oklch(0.36 0.07 258)",
  sand: "oklch(0.78 0.05 82)",
  charcoal: "oklch(0.31 0.004 285)",
  cream: "oklch(0.92 0.02 92)",
} as const;

export type CoverColorName = keyof typeof COVER_COLORS;

/** Swatch order in the picker, and the names `album albums create --color` takes. */
export const COVER_COLOR_NAMES = [
  "oxblood",
  "forest",
  "navy",
  "sand",
  "charcoal",
  "cream",
] as const satisfies readonly CoverColorName[];
