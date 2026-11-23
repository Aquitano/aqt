import { Img, staticFile } from "remotion";

export type Orb = {
  file: string;
  width: number;
  height: number;
  /** The disc's centre, as fractions of the image's width and height. */
  cx: number;
  cy: number;
  /** The disc's radius, as a fraction of the image's width. */
  r: number;
  /** Exposure in stops, to even out brightness across the cut. */
  stops?: number;
};

/** Where every disc sits on screen, and how big it is. */
export const disc = { x: 960, y: 588, diameter: 740 } as const;

/** The shared grade lifts black to this warm near-black, so the frame matches every photograph's own black. */
export const graded = "#0d0b0a";

/** The top of the disc: words and the mark stand on it, as on a horizon. */
export const apex = disc.y - disc.diameter / 2;

const feather =
  "linear-gradient(to right, transparent, black 7%, black 93%, transparent), linear-gradient(to bottom, transparent, black 7%, black 93%, transparent)";

/**
 * One round thing, scaled so its disc has the same diameter and centre in every shot. The push-in
 * is anchored on the disc's centre. Edges of the photograph fade into the black frame.
 */
export function OrbShot({ orb, push }: { orb: Orb; push: number }) {
  const scale = (disc.diameter * (1 + 0.04 * push)) / (2 * orb.r * orb.width);
  const w = orb.width * scale;
  const h = orb.height * scale;
  return (
    <Img
      src={staticFile(`orbs/${orb.file}`)}
      style={{
        position: "absolute",
        left: disc.x - orb.cx * w,
        top: disc.y - orb.cy * h,
        width: w,
        height: h,
        filter: `brightness(${2 ** (orb.stops ?? 0)}) url(#grade)`,
        maskImage: feather,
        WebkitMaskImage: feather,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }}
    />
  );
}
