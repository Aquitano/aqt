import { bar } from "../timeline";

/**
 * The photographic films share one arc of 16 bars (34 s): three bars of observation, five of
 * pattern, four of cascade, and four for the answer. Versions differ only in their words.
 */
export const at = {
  observe: 0,
  pattern: 3 * bar,
  harmony: 5 * bar,
  cascade: 8 * bar,
  aha: 12 * bar,
} as const;

export const motif = [at.aha + 45, at.aha + 77, at.aha + 109] as const;
export const durationInFrames = 16 * bar;

/** One film's arc: where its parts start, the three closing notes, and its length. */
export type Arc = {
  at: { observe: number; pattern: number; harmony: number; cascade: number; aha: number };
  motif: readonly [number, number, number];
  durationInFrames: number;
};

export const shared: Arc = { at, motif, durationInFrames };

const quickAha = 8 * bar;

/**
 * Line's shorter arc of 11.5 bars (24.5 s): two of observation, four of pattern, two
 * of cascade, and three and a half to end. Its mark starts under a second after the cut.
 */
export const quick: Arc = {
  at: { observe: 0, pattern: 2 * bar, harmony: 4 * bar, cascade: 6 * bar, aha: quickAha },
  motif: [quickAha + 24, quickAha + 56, quickAha + 88],
  durationInFrames: 11.5 * bar,
};

const repeat = (times: number, lengths: number[]) =>
  Array.from({ length: times }, () => lengths).flat();

/** Cut lengths in frames: slow, then on the beat, then 12, 8, 6 and 4 frames into the cut. */
export const lengths = {
  observe: [72, 64, 56],
  pattern: [...repeat(4, [32]), ...repeat(12, [16])],
  cascade: [
    ...repeat(2, [12, 12, 8]),
    ...repeat(8, [8]),
    ...repeat(5, [8, 4]),
    4,
    ...repeat(16, [4]),
  ],
};

/**
 * Line's cuts: one held shot to open; three two-beat shots a phrase, the last phrase breaking into
 * single beats; four cuts of 12 frames under "Every answer"; then "has a source." over three
 * shots, the last held for a beat and a half into the hard cut, so the claim has time to stand.
 */
export const quickLengths = {
  observe: [128],
  pattern: [...repeat(7, [32]), 16, 16],
  cascade: [12, 12, 12, 12, 16, 16, 48],
};
