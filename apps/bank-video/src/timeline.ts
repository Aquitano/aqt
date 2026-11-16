import { record, stream, type Entry } from "./records";

export const fps = 30;
export const width = 1920;
export const height = 1080;
export const sampleRate = 48_000;

/** 112.5 bpm at 30 fps: a beat is 16 frames, so every sixteenth note lands on a whole frame. */
export const beat = 16;
export const bar = 4 * beat;

export const at = {
  observe: 0,
  pattern: 5 * bar,
  harmony: 9 * bar,
  cascade: 13 * bar,
  aha: 20 * bar,
} as const;

/** The three notes of the motif, played alone after the silence. */
export const motif = [at.aha + 45, at.aha + 77, at.aha + 109] as const;
export const durationInFrames = at.aha + 380;

export type Span = "day" | "month" | "year" | "decade";

/** The frames, within the scan shot, over which the scanner's light crosses the page. */
export const scanSweep = { from: 2, to: 44 } as const;

export type Shot =
  | { type: "caret" }
  | { type: "record"; entry: Entry; close?: boolean }
  | { type: "scan"; entry: Entry }
  | { type: "query"; command: string; query: string }
  | { type: "derive"; entry: Entry }
  | { type: "resolve" }
  | { type: "count" }
  | { type: "contact" }
  | { type: "day" }
  | { type: "sources" }
  | { type: "field"; span: Span }
  | { type: "plate" }
  | { type: "answer" };

export type Scale = "record" | "instrument" | "archive";

const scales = {
  caret: "instrument",
  query: "instrument",
  derive: "instrument",
  resolve: "instrument",
  count: "instrument",
  contact: "instrument",
  record: "record",
  scan: "record",
  answer: "record",
  day: "archive",
  sources: "archive",
  field: "archive",
  plate: "archive",
} satisfies Record<Shot["type"], Scale>;

export const scaleOf = (shot: Shot): Scale => scales[shot.type];

/** A shot on screen from `from` for `duration` frames. A record's ref lands `stamp` frames in. */
export type Cut = { from: number; duration: number; shot: Shot; stamp: number };

export const query = { command: "siglum search", query: "deposit returned" } as const;

/** One key per sixteenth, so the last one lands just before the downbeat that starts the music. */
export const keystrokes = Array.from(
  { length: query.query.length },
  (_, i) => at.pattern - bar + 4 * i,
);

const observe: Omit<Cut, "stamp">[] = [
  { from: 0, duration: 72, shot: { type: "caret" } },
  { from: 72, duration: 64, shot: { type: "record", entry: record("transfer"), close: true } },
  { from: 136, duration: 56, shot: { type: "field", span: "decade" } },
  { from: 192, duration: 64, shot: { type: "scan", entry: record("receipt") } },
  { from: 256, duration: 64, shot: { type: "query", ...query } },
];

const pattern: Shot[] = [
  { type: "record", entry: record("handover") },
  { type: "derive", entry: record("handover") },
  { type: "record", entry: record("keys") },
  { type: "day" },
  { type: "record", entry: record("lease") },
  { type: "resolve" },
  { type: "sources" },
  { type: "record", entry: record("checklist") },
  { type: "count" },
  { type: "field", span: "month" },
  { type: "record", entry: record("howto") },
  { type: "contact" },
  { type: "plate" },
  { type: "record", entry: record("ship") },
  { type: "derive", entry: record("ship") },
  { type: "field", span: "year" },
  { type: "record", entry: record("congrats") },
  { type: "derive", entry: record("congrats") },
  { type: "sources" },
  { type: "record", entry: record("engine") },
  { type: "resolve" },
  { type: "plate" },
  { type: "record", entry: record("episodes") },
  { type: "count" },
  { type: "field", span: "decade" },
  { type: "record", entry: record("landing") },
  { type: "contact" },
  { type: "field", span: "decade" },
];

/** Four shots of two beats, then a shot per beat. */
const patternDurations = pattern.map((_, i) => (i < 4 ? 2 * beat : beat));

/**
 * Cuts of 12, 8, 6 and 4 frames: two bars in a three-three-two rhythm, two bars of eighths,
 * a bar of long-short pairs that average six frames, then two bars of sixteenths.
 */
const cascadeDurations = [
  ...Array.from({ length: 4 }, () => [12, 12, 8]).flat(),
  ...Array.from({ length: 16 }, () => 8),
  ...Array.from({ length: 5 }, () => [8, 4]).flat(),
  4,
  ...Array.from({ length: 32 }, () => 4),
];

const cycle = <T>(list: readonly [T, ...T[]], i: number): T => list[i % list.length] ?? list[0];

const instruments: [(previous: Entry) => Shot, ...((previous: Entry) => Shot)[]] = [
  (entry) => ({ type: "derive", entry }),
  () => ({ type: "resolve" }),
  () => ({ type: "count" }),
  () => ({ type: "contact" }),
];

const archives: [Shot, ...Shot[]] = [
  { type: "field", span: "month" },
  { type: "plate" },
  { type: "sources" },
  { type: "field", span: "year" },
  { type: "day" },
  { type: "field", span: "decade" },
];

const cascade = (): Shot[] => {
  const entries = stream(Math.ceil(cascadeDurations.length / 2));
  let previous = record("handover");
  return cascadeDurations.map((_, i) => {
    const step = i % 4;
    if (step === 0 || step === 2) {
      previous = entries[i / 2] ?? previous;
      return { type: "record", entry: previous };
    }
    if (step === 1) return cycle(instruments, (i - 1) / 4)(previous);
    return cycle(archives, (i - 3) / 4);
  });
};

const sequence = (start: number, shots: Shot[], durations: number[]) => {
  let from = start;
  return shots.map((shot, i) => {
    const duration = durations[i] ?? beat;
    const cut = { from, duration, shot };
    from += duration;
    return cut;
  });
};

export const hasStamp = (shot: Shot) =>
  shot.type === "record" || shot.type === "scan" || shot.type === "derive";

/** When the ref lands: late in the slow shots, on the half beat in the pattern, at once in the cascade. */
const stamped = ({ from, duration, shot }: Omit<Cut, "stamp">): Cut => {
  if (!hasStamp(shot) || from >= at.cascade) return { from, duration, shot, stamp: 0 };
  if (from >= at.pattern) return { from, duration, shot, stamp: duration / 2 };
  return { from, duration, shot, stamp: 24 };
};

const finale: Omit<Cut, "stamp"> = {
  from: at.aha,
  duration: durationInFrames - at.aha,
  shot: { type: "answer" },
};

export const cuts: Cut[] = [
  ...observe,
  ...sequence(at.pattern, pattern, patternDurations),
  ...sequence(at.cascade, cascade(), cascadeDurations),
  finale,
].map(stamped);
