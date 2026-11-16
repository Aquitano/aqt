import { kinds } from "./brand";
import { day, mulberry, totalRecords, type Kind } from "./records";

const msPerDay = 86_400_000;
const epoch = Date.UTC(2014, 0, 1);

/** Days since 2014-01-01, with the time of day as the fraction. */
export const dayOf = (date: string, time = "12:00") =>
  (Date.parse(`${date}T${time}:00Z`) - epoch) / msPerDay;

export const span = Math.ceil(dayOf("2025-09-01", "00:00"));
export const firstYear = 2014;
export const years = 12;

/** Each kind of record drifts along its own slow stream, so the archive looks like braided rivers. */
export const lane = (kind: number, x: number) =>
  0.3 * Math.sin(x / 420 + kind * 1.3) + 0.12 * Math.sin(x / 97 + kind * 2.1) + (kind - 2) * 0.07;

export type Archive = {
  x: Float32Array;
  y: Float32Array;
  /** Index into `kinds`; points are sorted by it, so a pass per colour draws them all. */
  kind: Uint8Array;
  /** Where each kind's run of points starts. */
  starts: number[];
  perDay: Uint16Array;
  maxPerDay: number;
};

const build = (): Archive => {
  const random = mulberry(7);
  const gauss = () =>
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  const aiFrom = dayOf("2022-12-01");
  const bursts = Array.from({ length: 70 }, () => ({
    at: span * Math.sqrt(random()),
    width: 2 + random() * 9,
  }));
  const hours = [9, 13, 19, 22];
  const weights: [Kind, number][] = [
    ["mail", 0.38],
    ["chat", 0.34],
    ["library", 0.13],
    ["drives", 0.06],
    ["ai", 0.09],
  ];

  const raw = Array.from({ length: totalRecords }, () => {
    const burst = bursts[Math.floor(random() * bursts.length)];
    const at =
      burst && random() < 0.22 ? burst.at + gauss() * burst.width : span * random() ** 0.62;
    const date = Math.min(Math.max(Math.floor(at), 0), span - 1);
    const hour = (hours[Math.floor(random() * hours.length)] ?? 12) + gauss() * 1.6;
    const x = date + Math.min(Math.max(hour / 24, 0), 0.999);
    let pick = random();
    let kind: Kind = "mail";
    for (const [k, w] of weights) {
      if (pick < w) {
        kind = k;
        break;
      }
      pick -= w;
    }
    if (kind === "ai" && x < aiFrom) kind = "chat";
    const index = kinds.indexOf(kind);
    return { x, y: lane(index, x) + gauss() * 0.055, kind: index };
  });

  const featured = day.map((entry) => {
    const index = kinds.indexOf(entry.kind);
    const x = dayOf(entry.date, entry.time);
    return { x, y: lane(index, x), kind: index };
  });

  const all = [...raw, ...featured].toSorted((a, b) => a.kind - b.kind);
  const perDay = new Uint16Array(span);
  for (const p of all) perDay[Math.floor(p.x)] = (perDay[Math.floor(p.x)] ?? 0) + 1;

  return {
    x: Float32Array.from(all, (p) => p.x),
    y: Float32Array.from(all, (p) => p.y),
    kind: Uint8Array.from(all, (p) => p.kind),
    starts: kinds.map((_, k) => all.findIndex((p) => p.kind === k)),
    perDay,
    maxPerDay: perDay.reduce((a, b) => Math.max(a, b), 0),
  };
};

export const archive = build();
