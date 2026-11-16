import { bar, beat } from "../../timeline";
import { at, durationInFrames, lengths } from "../plan";
import { orbs as manifest, type OrbId } from "./orbs";

export const orbs = manifest;

/** Made, natural and cosmic in turn, so no two neighbouring discs share a scale. */
const made: [OrbId, ...OrbId[]] = [
  "coinGold",
  "astrolabe",
  "centCopper",
  "platePoppy",
  "decimes",
  "centPattern",
  "plateRouen",
];
const natural: [OrbId, ...OrbId[]] = [
  "plateSensitivity",
  "urchinPink",
  "plateAmber",
  "plateYellow",
  "urchinCream",
  "plateConcentric",
  "plateWhite",
  "plateCream",
  "plateSoil",
];
const cosmic: [OrbId, ...OrbId[]] = [
  "jupiter",
  "sunGold",
  "mars",
  "neptune",
  "sunTeal",
  "io",
  "earth",
  "sunViolet",
  "venus",
  "pluto",
  "sunRed",
  "ceres",
  "uranus",
  "mercury",
  "sunVisible",
];

const cycle = (list: [OrbId, ...OrbId[]], i: number): OrbId => list[i % list.length] ?? list[0];

/** The Moon opens and closes the film; a culture with rings and the Golden Record observe with it. */
const opening: OrbId[] = ["moon", "plateRings", "goldenRecord"];

const starts = (from: number, durations: number[]) => {
  let at2 = from;
  return durations.map((duration) => {
    const slot = { from: at2, duration };
    at2 += duration;
    return slot;
  });
};

export type Shot = { from: number; duration: number; orb: OrbId };

export const sequence: Shot[] = [
  ...starts(at.observe, lengths.observe).map(({ from, duration }, i) => ({
    from,
    duration,
    orb: opening[i] ?? "moon",
  })),
  ...starts(at.pattern, [...lengths.pattern, ...lengths.cascade]).map(({ from, duration }, i) => {
    const turn = Math.floor(i / 3);
    const orb = [cycle(made, turn), cycle(natural, turn), cycle(cosmic, turn)][i % 3] ?? "moon";
    return { from, duration, orb };
  }),
  { from: at.aha, duration: durationInFrames - at.aha, orb: "moon" },
];

/** Words held on the disc's top edge while the discs change beneath them. */
export const spans = [
  { from: at.pattern, to: at.pattern + 2 * bar, text: "What you wrote." },
  { from: at.pattern + 2 * bar, to: at.pattern + 3.5 * bar, text: "What you received." },
  { from: at.pattern + 3.5 * bar, to: at.cascade, text: "What you saved." },
  ...["Every", "answer", "has a", "source."].map((text, i) => ({
    from: at.aha - bar + i * beat,
    to: at.aha - bar + (i + 1) * beat,
    text,
  })),
];

/** What the score needs from this film: a click on every cut. */
export const orbsScore = { id: "orbs", cuts: sequence, keystrokes: [], stamps: [] };
