import type { GalleryTheme } from "./types";

/**
 * Presentation half of the theme contract. The *shape* is owned by the server
 * (`@aqt/gallery-db/schema/theme`) and reaches the client through tRPC type
 * inference as `GalleryTheme`. The *fallback values* are a rendering concern,
 * so they live here — once — and are shared by the 3D renderer (`gallery-scene`)
 * and the editor (`gallery-theme-panel`).
 */

/** Editable theme: the non-null view of the server's nullable theme column. */
export type ThemeValue = NonNullable<GalleryTheme>;

export const LIGHT_COLORS = {
  warm: "#ffe2b8",
  neutral: "#fff3e2",
  cool: "#e8eeff",
} as const;

/** The renderer's fallback for every unset field. */
export const THEME_DEFAULTS = {
  wallColor: "#857b6c",
  accentWallColor: "#6e6354",
  floorColor: "#332b22",
  floorRoughness: 0.82,
  ambientIntensity: 1,
  lightTemperature: "warm",
} satisfies Required<ThemeValue>;

/** Fully resolved theme the 3D scene consumes: every field concrete, plus the
 * derived light color and scene background. */
export type ResolvedTheme = {
  wallColor: string;
  accentWallColor: string;
  floorColor: string;
  floorRoughness: number;
  ambientIntensity: number;
  lightColor: string;
  background: string;
};

/** Fill unset fields with defaults and map `lightTemperature` to a concrete
 * color — the one place a stored theme becomes renderable. */
export function resolveTheme(theme: GalleryTheme | null | undefined): ResolvedTheme {
  const t = theme ?? {};
  return {
    wallColor: t.wallColor ?? THEME_DEFAULTS.wallColor,
    accentWallColor: t.accentWallColor ?? t.wallColor ?? THEME_DEFAULTS.accentWallColor,
    floorColor: t.floorColor ?? THEME_DEFAULTS.floorColor,
    floorRoughness: t.floorRoughness ?? THEME_DEFAULTS.floorRoughness,
    ambientIntensity: t.ambientIntensity ?? THEME_DEFAULTS.ambientIntensity,
    lightColor:
      LIGHT_COLORS[t.lightTemperature ?? THEME_DEFAULTS.lightTemperature] ?? LIGHT_COLORS.warm,
    background: "#0b0a09",
  };
}

/** Fill any unset field so every editor control has a concrete value to bind
 * to. Unlike `resolveTheme`, this stays within the editable shape. */
export function withThemeDefaults(theme: ThemeValue | null | undefined): Required<ThemeValue> {
  return { ...THEME_DEFAULTS, ...(theme ?? {}) };
}
