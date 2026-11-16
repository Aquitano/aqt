import type { Lettering } from "./Lettered";
import type { PhotoId } from "./photos";

/*
 * The edges, rises, grain and thirds come from each framed image as it sits on screen: its edge
 * every 80 px, the 10-90% rise across that edge (how soft the photograph is), the noise in its
 * sky, and the brightness of its ground in thirds, in percent (where the light comes from). Inks
 * are written before the shared grade, chosen so that after it they fall inside the photograph's
 * own range: no word is brighter, darker or cooler than what is around it.
 */

const level = (offset: number) => Array.from({ length: 25 }, () => offset);

/** Follows the measured edge, averaged over `radius` neighbours either side, as a hand would. */
const follow = (measured: readonly number[], radius: number) =>
  measured.map((_, i) => {
    const window = measured.slice(Math.max(0, i - radius), i + radius + 1);
    return window.reduce((sum, v) => sum + v, 0) / window.length;
  });

/** Bends a line harder about its middle, so the word's curve reads at a glance. */
const bend = (edge: readonly number[], by: number) => {
  const middle = edge[12] ?? 0;
  return edge.map((offset) => middle + (offset - middle) * by);
};

/** A word as soft as the photograph: from the measured rise, less the type's own antialiasing. */
const focusFor = (rise: number) =>
  Math.min(1.3, Math.max(0.3, Math.sqrt(Math.max(0, (rise / 2.56) ** 2 - 0.25))));

/**
 * Earth's limb from the ISS: no brighter than the sunlit cloud (about 200 of 255 after the grade),
 * warmed at the foot by the Earth below, the airglow's blue wrapping the lower edges, and the light
 * leaning toward whichever side the sunglint is on.
 */
const limb = (
  edge: readonly number[],
  grain: number,
  thirds: readonly [number, number, number],
  by = 1.8,
): Lettering => {
  const lean = (thirds[2] - thirds[0]) / Math.max(...thirds);
  return {
    edge: bend(edge, by),
    ink: { from: "#aeadba", to: "#d1c5b6", angle: 90 - Math.max(-40, Math.min(40, lean * 160)) },
    focus: 0.5,
    grain: Math.max(grain, 0.0015),
    wrap: { color: "#7fb0ff", strength: 0.2 },
    glow: { color: "rgb(120 165 230 / 0.12)", radius: 3 },
  };
};

/**
 * The Moon on film: hard sunlight with no air, so the sunlit side of the word is the regolith's
 * own highlight and the far side falls off; the scan's softness and grain; a little halation. The
 * word follows the edge averaged over `settle` neighbours, so it rides the ground without
 * climbing every hill, bent half again as hard so the ride shows.
 */
const moon = (
  measured: readonly number[],
  {
    rise,
    grain,
    sun,
    settle = 4,
  }: {
    rise: number;
    grain: number;
    sun: "left" | "right" | "above";
    settle?: number;
  },
): Lettering => ({
  edge: bend(follow(measured, settle), 1.5),
  ink: {
    from: "#dedbd2",
    to: sun === "above" ? "#d0cdd2" : "#c2bfd3",
    angle: { left: 0, right: 180, above: 90 }[sun],
  },
  focus: focusFor(rise),
  grain: Math.max(grain, 0.004),
  glow: { color: "rgb(255 236 214 / 0.22)", radius: 5 },
});

const lettering = {
  /* Dusk over wet tidal flats: cream lit by the amber band at the horizon, which wraps its edges. */
  sandgate: {
    edge: level(18),
    ink: { from: "#ece6da", to: "#f6e2d6", angle: 90 },
    focus: focusFor(1.9),
    grain: 0.0102,
    wrap: { color: "#ffc884", strength: 0.4 },
  },
  /* The same shore a little later: against the amber band, a silhouette like its tree line. */
  sandgate2: {
    edge: level(20),
    ink: "#2c1c12",
    focus: focusFor(1.9),
    grain: 0.0102,
    wrap: { color: "#ffc884", strength: 0.35 },
  },
  /*
   * Into the sun over the sea: lit like the sun's own path on the water, pale gold against the
   * dark cloud band behind it, with the sunset's orange spilling round it.
   */
  atlantic: {
    edge: level(-8),
    ink: { from: "#f4e6cc", to: "#f6d6a4", angle: 90 },
    focus: 1.1,
    grain: 0.0156,
    glow: { color: "rgb(255 150 60 / 0.45)", radius: 6 },
  },
  /*
   * Pink dusk over the mesa: dark as the shadowed rock, a little lost in the haze. The skyline
   * measures 0 to 2 px on both caprocks with a notch between them, so the word rests level across the
   * two tops instead of dipping into the notch, resting on them.
   */
  cliffs: {
    edge: level(12),
    ink: "#3a1c30",
    focus: 1.2,
    grain: 0.0034,
    wrap: { color: "#f0b0b8", strength: 0.35 },
  },
  /* Storm light over white salt: cool white, brightest at the foot where the salt throws light up. */
  saltflat: {
    edge: [7, 6, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 6, 7, 7, 7, 7, 7, 7, 7, 6, 6, 7, 7, 7],
    ink: { from: "#c2bfd3", to: "#dedbd2", angle: 90 },
    focus: 1.1,
    grain: 0.0077,
    wrap: { color: "#b8c4ea", strength: 0.3 },
  },
  pacific: limb(
    [36, 32, 27, 21, 17, 13, 9, 6, 3, 1, -1, -2, -3, -4, -4, -3, -2, -1, 1, 3, 6, 10, 13, 18, 20],
    0.0025,
    [55, 63, 60],
    /* This limb's low point is right of centre, so a hard bend reads as a tilt. */
    1.2,
  ),
  southpacific: limb(
    [
      37, 34, 31, 28, 24, 22, 20, 18, 17, 16, 15, 14, 15, 15, 15, 16, 17, 18, 20, 22, 25, 28, 31,
      35, 38,
    ],
    0.0017,
    [46, 49, 54],
  ),
  caspian: limb(
    [57, 56, 53, 51, 10, 8, 6, 4, 3, 2, 2, 1, 1, 1, 2, 3, 4, 6, 7, 10, 12, 15, 18, 22, 25],
    0.0003,
    [69, 74, 76],
  ),
  biscay: limb(
    [27, 24, 20, 17, 13, 10, 8, 6, 4, 2, 1, 0, 0, 0, 0, 1, 2, 4, 5, 7, 10, 18, 21, 25, 27],
    0.0016,
    [33, 35, 39],
  ),
  midway: limb(
    [20, 18, 16, 13, 11, 9, 8, 7, 5, 4, 4, 3, 3, 4, 4, 5, 6, 7, 9, 10, 13, 15, 17, 20, 22],
    0.0007,
    [43, 42, 40],
  ),
  okhotsk: limb(
    [27, 23, 20, 17, 12, 10, 8, 4, 4, 2, 1, -1, 0, -1, 0, 1, 2, 4, 6, 9, 12, 16, 21, 26, 28],
    0.0013,
    [55, 65, 54],
  ),
  bahamas: limb(
    [23, 20, 18, 17, 15, 13, 10, 10, 8, 8, 7, 6, 6, 7, 6, 7, 7, 8, 10, 10, 12, 15, 16, 19, 22],
    0.0006,
    [55, 56, 55],
  ),
  westaustralia: limb(
    [14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 7, 7, 7, 8, 8, 8, 9, 9, 10, 11, 12, 13, 14, 15, 16],
    0,
    [40, 36, 34],
  ),
  southernocean: limb(
    [25, 22, 18, 14, 11, 8, 6, 4, 2, 1, 0, 0, 0, 0, 1, 2, 3, 4, 6, 9, 12, 15, 18, 22, 25],
    0.0008,
    [45, 54, 43],
  ),
  smythii: moon(
    [
      -1, -6, -3, -1, 0, 10, 14, 19, 14, 8, 2, 5, 11, 7, 2, 0, -10, -17, -23, -26, -10, -7, -3, -2,
      1,
    ],
    /* A ridge rises 26 px on the right; the word stays level across the plain instead. */
    { rise: 4.8, grain: 0.0005, sun: "left", settle: 12 },
  ),
  apollo8west: moon(
    [18, 16, 12, 8, 10, 10, 9, 7, 4, 3, 3, 2, 0, 1, 2, 2, 1, 3, 5, 7, 10, 12, 14, 18, 22],
    { rise: 3.3, grain: 0.0013, sun: "left" },
  ),
  farside: moon(
    [28, 24, 15, 10, 2, 1, 0, 8, 5, 5, 5, 4, -2, -1, -1, 3, 7, 11, 8, 4, 5, 6, 9, 23, 29],
    { rise: 3.9, grain: 0.0005, sun: "right" },
  ),
  tranquility: moon([3, 3, 4, 5, 5, 6, 5, 5, 3, 3, 4, 4, 5, 5, 4, 4, 5, 5, 5, 5, 4, 3, 3, 5, 4], {
    rise: 4.7,
    grain: 0.0051,
    sun: "left",
  }),
  mound: moon([1, 3, 6, 7, 5, 5, 7, 7, 7, 8, 8, 9, 11, 12, 15, 12, 9, 6, 6, 4, 3, 3, 5, 6, 7], {
    rise: 4.1,
    grain: 0,
    sun: "left",
  }),
  vangent: moon(
    [90, 69, 5, 13, 12, 10, -3, 2, 5, 3, 2, 8, 11, 18, 18, 15, 16, 15, 7, 1, -2, -4, 1, 0, -1],
    { rise: 5.1, grain: 0.0099, sun: "above" },
  ),
  apollo8west2: moon(
    [19, 17, 13, 12, 14, 11, 10, 8, 7, 7, 6, 7, 6, 6, 7, 7, 7, 6, 8, 11, 13, 13, 16, 18, 19],
    { rise: 4.6, grain: 0.0012, sun: "left" },
  ),
  apollo8southwest: moon(
    [-1, -2, 8, 9, 2, -12, -9, 4, 14, 15, 26, 18, 4, 3, 6, 1, -4, -4, 0, -5, -3, -1, 6, 15, 15],
    { rise: 4.5, grain: 0.0068, sun: "left", settle: 5 },
  ),
  apollo11surface: moon(
    [8, 8, 6, 1, -2, -4, -3, 0, 6, 13, 13, 13, 14, 15, 13, 12, 9, 8, 6, 2, 2, 2, 4, 4, 3],
    { rise: 3, grain: 0, sun: "right" },
  ),
  apollo12craters: moon(
    [30, 31, 13, 10, 12, 8, 5, 3, 4, 5, 3, 0, 1, 1, 5, 1, 2, 3, 3, 5, 11, 14, 17, 21, 25],
    { rise: 5, grain: 0.0043, sun: "left" },
  ),
} satisfies Partial<Record<PhotoId, Lettering>>;

const isLettered = (id: PhotoId): id is keyof typeof lettering => Object.hasOwn(lettering, id);

/** How far below the centre line an image's edge was measured at mid-frame, before its line was reset. */
export const horizonOf = (id: PhotoId) => (isLettered(id) ? (lettering[id].edge[12] ?? 0) : 0);

/**
 * Each image's `line` in photos.ts was reset from these measurements, so its edge crosses the
 * middle of the frame exactly on the centre line. The edges here are therefore read relative to
 * their own middle: every word stands at the same height, and only its curve changes at a cut.
 */
export const letteringOf = (id: PhotoId): Lettering | undefined => {
  if (!isLettered(id)) return undefined;
  const set: Lettering = lettering[id];
  const middle = horizonOf(id);
  return { ...set, edge: set.edge.map((offset) => offset - middle) };
};

/**
 * One line for a whole phrase: the average of its shots' edges. A word that kept each shot's own
 * curve would shift a few pixels at every cut; on the shared line it does not move at all while
 * its phrase is on screen, and still bends the way its images do.
 */
export const sharedEdge = (ids: readonly PhotoId[]) => {
  const edges = ids.flatMap((id) => {
    const edge = letteringOf(id)?.edge;
    return edge ? [edge] : [];
  });
  return Array.from(
    { length: 25 },
    (_, i) => edges.reduce((sum, edge) => sum + (edge[i] ?? 0), 0) / Math.max(1, edges.length),
  );
};
