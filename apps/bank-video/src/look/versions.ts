import { mulberry, record, refFor, type Kind } from "../records";
import { bar, beat } from "../timeline";
import { photos, type PhotoId } from "./photos";
import {
  at,
  durationInFrames,
  lengths,
  motif,
  quick,
  quickLengths,
  shared,
  type Arc,
} from "./plan";

export type Words =
  | { kind: "serif"; text: string }
  /** A record found by the search: its text on the line, and its source and ref under it. */
  | { kind: "hit"; text: string; note: string }
  /** A ref passing under the line, with no text above it. */
  | { kind: "ref"; note: string }
  | { kind: "query"; command: string; query: string }
  | { kind: "answer"; note: boolean }
  | { kind: "lockup"; tagline?: string }
  /** The mark pressed in like a seal and the name rising after it, one event per note of the motif. */
  | { kind: "seal" };

export type Span = { from: number; to: number; words: Words };
export type Cut = { from: number; duration: number; photo: PhotoId };

export type Version = {
  id: "line" | "search" | "sources" | "cited";
  arc: Arc;
  cuts: Cut[];
  spans: Span[];
  keystrokes: number[];
  /** Frames where something lands on screen, a ref or the mark, each with a click in the score. */
  stamps: number[];
  /** Cite every image in a footnote, numbered by source, as an edition does. */
  footnotes?: boolean;
  /** Set each word to the edge and light of the shot under it (`lettering.ts`). */
  lettered?: boolean;
};

/** Record, specimen and phenomenon in turn, so no two neighbours share a scale. */
const rotation: PhotoId[] = [
  "notebook",
  "wing",
  "jupiter",
  "type",
  "iron",
  "aurora",
  "seismogram",
  "frost",
  "saltflat",
  "fieldbook",
  "gneiss",
  "lava",
  "sliderule",
  "agate",
  "clouds",
  "spectra",
  "core",
  "cliffs",
  "rowland",
  "fossil",
  "bering",
  "catalogue",
  "atlantic",
  "shelf",
];

const opening: PhotoId[] = ["rays", "ledger", "milkyway"];

const sequence = (start: number, durations: number[]) => {
  let from = start;
  return durations.map((duration) => {
    const slot = { from, duration };
    from += duration;
    return slot;
  });
};

const observeCuts = sequence(at.observe, lengths.observe);
const moving = sequence(at.pattern, [...lengths.pattern, ...lengths.cascade]);

/** Every version returns to the same horizon for its ending. */
const cutsFor = (first: PhotoId[], then: PhotoId[]): Cut[] => [
  ...observeCuts.map(({ from, duration }, i) => ({ from, duration, photo: first[i] ?? "rays" })),
  ...moving.map(({ from, duration }, i) => ({
    from,
    duration,
    photo: then[i % then.length] ?? "rays",
  })),
  { from: at.aha, duration: durationInFrames - at.aha, photo: "rays" },
];

/** Search, Sources and Cited share one sequence, so they compare fairly. */
const cuts = cutsFor(opening, rotation);

/**
 * Line cuts only between horizons, each with a calm sky above its line and dense material below,
 * so the words always stand in the same quiet band. It rises from the sea at dusk to Earth's limb
 * and the Moon, one phrase each, with no two neighbours alike. "Every answer" then crosses all
 * three worlds again, and "has a source." crosses two lunar plains to an Apollo plate whose reseau crosses mark where
 * it was measured from.
 */
const lineOpening: PhotoId[] = ["rays"];
const lineShots: PhotoId[] = [
  "sandgate",
  "atlantic",
  "cliffs",
  "pacific",
  "biscay",
  "bahamas",
  "smythii",
  "mound",
  "vangent",
  "sandgate2",
  "southernocean",
  "farside",
  "westaustralia",
  "tranquility",
  "apollo8west",
  "apollo11surface",
];

const lineCuts: Cut[] = [
  ...sequence(quick.at.observe, quickLengths.observe).map(({ from, duration }, i) => ({
    from,
    duration,
    photo: lineOpening[i] ?? "rays",
  })),
  ...sequence(quick.at.pattern, [...quickLengths.pattern, ...quickLengths.cascade]).map(
    ({ from, duration }, i) => ({ from, duration, photo: lineShots[i] ?? "rays" }),
  ),
  { from: quick.at.aha, duration: quick.durationInFrames - quick.at.aha, photo: "rays" },
];

const lockupAt = motif[2];
const tagline = "Search what you wrote, received and saved.";

const finale = (answer: Span["words"], withTagline: boolean): Span[] => [
  { from: at.aha, to: motif[1] + 16, words: answer },
  {
    from: lockupAt,
    to: durationInFrames,
    words: withTagline ? { kind: "lockup", tagline } : { kind: "lockup" },
  },
];

const words = (from: number, list: string[], each: number): Span[] =>
  list.map((text, i) => ({
    from: from + i * each,
    to: from + (i + 1) * each,
    words: { kind: "serif", text },
  }));

const line: Version = {
  id: "line",
  arc: quick,
  lettered: true,
  cuts: lineCuts,
  spans: [
    {
      from: quick.at.pattern,
      to: quick.at.pattern + 6 * beat,
      words: { kind: "serif", text: "What you wrote." },
    },
    {
      from: quick.at.pattern + 6 * beat,
      to: quick.at.pattern + 12 * beat,
      words: { kind: "serif", text: "What you received." },
    },
    {
      from: quick.at.pattern + 12 * beat,
      to: quick.at.cascade,
      words: { kind: "serif", text: "What you saved." },
    },
    {
      from: quick.at.cascade,
      to: quick.at.cascade + 3 * beat,
      words: { kind: "serif", text: "Every answer" },
    },
    {
      from: quick.at.cascade + 3 * beat,
      to: quick.at.aha,
      words: { kind: "serif", text: "has a source." },
    },
    { from: quick.motif[0], to: quick.durationInFrames, words: { kind: "seal" } },
  ],
  keystrokes: [],
  stamps: [quick.motif[0] + 2, quick.motif[1] + 2],
};

const query = { command: "siglum search", query: "deposit returned" };
const keystrokes = Array.from({ length: query.query.length }, (_, i) => at.pattern - bar + 4 * i);

const hits: { text: string; source: string; ref: string }[] = [
  { text: "did you transfer the deposit?", source: "WhatsApp", ref: record("transfer").ref },
  { text: "Re: Deposit and key handover", source: "Gmail", ref: record("handover").ref },
  { text: "deposit_receipt.pdf", source: "archive-2", ref: record("receipt").ref },
  { text: "summarise the handover checklist", source: "ChatGPT", ref: record("checklist").ref },
  { text: "How to read a lease", source: "YouTube", ref: record("howto").ref },
];

const sources: { name: string; kind: Kind }[] = [
  { name: "Gmail", kind: "mail" },
  { name: "WhatsApp", kind: "chat" },
  { name: "Discord", kind: "chat" },
  { name: "Claude", kind: "ai" },
  { name: "Drives", kind: "drives" },
  { name: "LinkedIn", kind: "chat" },
  { name: "YouTube", kind: "library" },
  { name: "ChatGPT", kind: "ai" },
  { name: "IMAP", kind: "mail" },
  { name: "Netflix", kind: "library" },
];

/** Refs from every source passing under the line while the cascade searches the archive. */
const passing = (): Span[] => {
  const random = mulberry(7);
  return moving
    .filter((slot) => slot.from >= at.cascade)
    .map((slot, i) => {
      const source = sources[i % sources.length] ?? { name: "Gmail", kind: "mail" };
      return {
        from: slot.from,
        to: slot.from + slot.duration,
        words: { kind: "ref", note: `${source.name} · ${refFor(source.kind, random)}` },
      };
    });
};

const search: Version = {
  id: "search",
  arc: shared,
  cuts,
  spans: [
    { from: 24, to: at.pattern, words: { kind: "query", ...query } },
    ...hits.map((hit, i) => ({
      from: at.pattern + i * bar,
      to: at.pattern + (i + 1) * bar,
      words: { kind: "hit" as const, text: hit.text, note: `${hit.source} · ${hit.ref}` },
    })),
    ...passing(),
    ...finale({ kind: "answer", note: true }, true),
  ],
  keystrokes,
  stamps: hits.map((_, i) => at.pattern + i * bar + beat / 2),
};

const named = [
  "Gmail",
  "WhatsApp",
  "Discord",
  "LinkedIn",
  "ChatGPT",
  "Claude",
  "YouTube",
  "Netflix",
  "Drives",
  "One archive.",
];

const tour: Version = {
  id: "sources",
  arc: shared,
  cuts,
  spans: [
    ...words(at.pattern, named, 2 * beat),
    ...words(at.cascade, ["Search it", "from a terminal,", "a browser,", "or an agent."], bar),
    ...finale({ kind: "serif", text: "Every answer has a source." }, true),
  ],
  keystrokes: [],
  stamps: [],
};

const cited: Version = {
  id: "cited",
  arc: shared,
  cuts,
  spans: [
    {
      from: at.pattern,
      to: at.pattern + 2.5 * bar,
      words: { kind: "serif", text: "Every record" },
    },
    {
      from: at.pattern + 2.5 * bar,
      to: at.cascade,
      words: { kind: "serif", text: "has a source." },
    },
    ...finale({ kind: "answer", note: false }, true),
  ],
  keystrokes: [],
  stamps: [],
  footnotes: true,
};

export const versions = [line, search, tour, cited] as const;

export { cuts as sharedCuts };

export const photoOf = (id: PhotoId) => photos[id];

/** Footnote numbers by first appearance, so a source shown twice keeps its number. */
export const sourceOrder: PhotoId[] = cuts
  .map((c) => c.photo)
  .filter((id, i, all) => all.indexOf(id) === i);
