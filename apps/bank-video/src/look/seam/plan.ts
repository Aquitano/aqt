import type { PhotoId } from "../photos";
import { at, durationInFrames, lengths } from "../plan";

export type Shot = { from: number; duration: number; photo: PhotoId };

type Pair = readonly [top: PhotoId, bottom: PhotoId];

/** Pairings whose lines rhyme across the seam. Both halves cut together, on the shared grid. */
const pairs: [Pair, ...Pair[]] = [
  ["bering", "atlantic"],
  ["aurora", "ledger"],
  ["milkyway", "saltflat"],
  ["jupiter", "frost"],
  ["type", "lava"],
  ["spectra", "rowland"],
  ["cliffs", "shelf"],
  ["notebook", "fossil"],
  ["gneiss", "iron"],
  ["seismogram", "core"],
  ["clouds", "bering"],
  ["catalogue", "fieldbook"],
  ["wing", "agate"],
  ["ledger", "milkyway"],
  ["sliderule", "seismogram"],
  ["atlantic", "clouds"],
  ["fieldbook", "jupiter"],
  ["lava", "cliffs"],
  ["frost", "gneiss"],
];

/**
 * In the cascade the halves take turns: the top changes on even cuts, the bottom on odd ones.
 * Each walk steps between images of similar brightness in that half, so neither half flashes.
 */
const walks = {
  top: [
    "type",
    "agate",
    "wing",
    "catalogue",
    "shelf",
    "lava",
    "iron",
    "core",
    "frost",
    "clouds",
    "milkyway",
    "saltflat",
    "notebook",
    "rowland",
    "ledger",
    "fossil",
    "jupiter",
    "seismogram",
    "bering",
    "sliderule",
    "cliffs",
  ],
  bottom: [
    "notebook",
    "seismogram",
    "sliderule",
    "jupiter",
    "aurora",
    "saltflat",
    "spectra",
    "rowland",
    "atlantic",
    "core",
    "agate",
    "frost",
    "shelf",
    "iron",
    "catalogue",
    "ledger",
    "gneiss",
    "fossil",
    "cliffs",
    "lava",
  ],
} satisfies Record<"top" | "bottom", [PhotoId, ...PhotoId[]]>;

const cycle = <T>(list: readonly [T, ...T[]], i: number): T => list[i % list.length] ?? list[0];

const starts = (start: number, durations: readonly number[]) => {
  let from = start;
  return durations.map((duration) => {
    const slot = from;
    from += duration;
    return slot;
  });
};

const held = <T extends { from: number }>(list: T[]) =>
  list.map((item, i) => ({
    ...item,
    duration: (list[i + 1]?.from ?? durationInFrames) - item.from,
  }));

const calm = starts(at.observe, [...lengths.observe, ...lengths.pattern]);
const fast = starts(at.cascade, lengths.cascade);

const half = (side: 0 | 1, walk: [PhotoId, ...PhotoId[]]): Shot[] =>
  held([
    ...calm.map((from, i) => ({ from, photo: cycle(pairs, i)[side] })),
    ...fast.filter((_, i) => i % 2 === side).map((from, i) => ({ from, photo: cycle(walk, i) })),
    { from: at.aha, photo: "rays" },
  ]);

/** At `at.aha` both halves become the same photograph, whole for the first time. */
export const halves = { top: half(0, walks.top), bottom: half(1, walks.bottom) };

const changes = [...new Set([...halves.top, ...halves.bottom].map((shot) => shot.from))].toSorted(
  (a, b) => a - b,
);

/** What the score needs from the Seam film: a click wherever either half changes. */
export const seam = {
  id: "seam",
  cuts: held(changes.map((from) => ({ from }))),
  keystrokes: [],
  stamps: [],
};
