/**
 * Pure, dependency-free layout primitives shared by the 3D renderer
 * (apps/web) and the pre-publish linter (apps/server): geometry constants,
 * dimension parsing and display sizing. world.ts builds the floor plan on top
 * of these; keeping them in their own module lets world.ts import them without
 * a cycle through the package barrel.
 *
 * No three.js, no DB types — only plain numbers and structural inputs.
 */

export type WallId = "north" | "south" | "east" | "west";

// ── Geometry constants (meters) ─────────────────────────────────────────────
export const WALL_THICKNESS = 0.36;
export const DOOR_WIDTH = 2.8;
export const DOOR_HEIGHT = 3.1;
export const EYE_HEIGHT = 1.7;
export const HANG_HEIGHT = 1.62;
export const PLAYER_RADIUS = 0.4;

/** Breathing room added around each canvas, and the minimum slot a work may
 * occupy along a wall. */
export const FRAME_MARGIN = 1.5;
export const MIN_SLOT = 2.6;

/** A procedurally-sized hall grows only between these depths; deeper walls
 * are split into connected halls by the renderer's auto-splitter. */
export const MAX_ROOM_DEPTH = 30;
export const MIN_ROOM_DEPTH = 12;
/** Clearance between a room end and the nearest painting on a side wall. */
export const WALL_END_MARGIN = 1.6;
/** Usable length of one side wall at maximum depth. */
export const MAX_SIDE_SPAN = MAX_ROOM_DEPTH - 2 * WALL_END_MARGIN;

export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Minimal structural view of an artwork the layout math needs. */
export type LayoutArtwork = {
  dimensions?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  /** Curated placement, when set. */
  wall?: WallId | null;
  wallOffset?: number | null;
  scale?: number | null;
};

/** Parse "73.7 × 92.1 cm" (height × width) into meters. The match is anchored
 * on the "cm" unit, so a string that also carries inches —
 * e.g. "29 x 36 1/4 in. (73.7 x 92.1 cm)" from the Met — still resolves to the
 * metric figures. */
export function parsePhysicalSize(
  dimensions: string | null | undefined,
): { height: number; width: number } | null {
  if (!dimensions) return null;
  const match = dimensions.match(/([\d.]+)\s*[×x]\s*([\d.]+)\s*cm/i);
  if (!match?.[1] || !match[2]) return null;
  const h = Number.parseFloat(match[1]) / 100;
  const w = Number.parseFloat(match[2]) / 100;
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) {
    return null;
  }
  return { height: h, width: w };
}

/** Display size in meters, scaled by the curatorial placement.scale. The
 * canvas always takes the image's aspect so the texture is never stretched;
 * real dimensions, when parseable, set how much wall area it covers. A source
 * image that is a detail crop of the catalogued work (or includes its frame)
 * then hangs at a plausible size instead of a distorted one. */
export function displaySize(artwork: LayoutArtwork): {
  width: number;
  height: number;
} {
  const scale = artwork.scale ?? 1;
  const physical = parsePhysicalSize(artwork.dimensions);
  const imageAspect =
    artwork.imageWidth && artwork.imageHeight ? artwork.imageWidth / artwork.imageHeight : null;
  if (physical && imageAspect === null) {
    return { width: physical.width * scale, height: physical.height * scale };
  }
  const aspect = imageAspect ?? 4 / 3;
  const height = physical
    ? Math.sqrt((physical.width * physical.height) / aspect) * scale
    : 1.2 * scale;
  return { width: height * aspect, height };
}

/** Along-wall footprint of one work, including frame margin and the minimum
 * slot floor. */
export function slotWidth(displayWidth: number): number {
  return Math.max(displayWidth + FRAME_MARGIN, MIN_SLOT);
}
