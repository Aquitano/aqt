import type { LimitWindow, ProviderLimits } from "@aqt/turnstash-api";
import { expect, test, vi } from "vite-plus/test";

import {
  burnPerHour,
  chartRowsOf,
  dayMs,
  dayTicksOf,
  drainBurstsOf,
  hourMs,
  paceOf,
  spanFor,
  projectLimit,
  useFirstOf,
} from "../src/limits-model";

const start = Date.UTC(2026, 9, 29, 12);
const iso = (ms: number) => new Date(ms).toISOString();

const windowOf = (points: ReadonlyArray<readonly [hours: number, used: number]>): LimitWindow => {
  const [first] = points;
  const last = points.at(-1);
  if (first === undefined || last === undefined) throw new Error("no points");
  return {
    windowMinutes: 10_080,
    startsAt: iso(start),
    resetsAt: iso(start + 7 * dayMs),
    endedAt: iso(start + 7 * dayMs),
    outcome: "open",
    firstObservedAt: iso(start + first[0] * hourMs),
    lastObservedAt: iso(start + last[0] * hourMs),
    firstUsedPercent: first[1],
    usedPercent: last[1],
    costUsd: 0,
    requests: 0,
    costPerPercentUsd: null,
    expiredValue: [],
    points: points.map(([hours, usedPercent]) => ({
      at: iso(start + hours * hourMs),
      usedPercent,
    })),
  };
};

test("burn reads the stretch the mode names, and the window mode ignores a quiet evening", () => {
  const window = windowOf([
    [0, 0],
    [10, 40],
    [20, 41],
  ]);
  const now = start + 20 * hourMs;
  expect(burnPerHour(window, "window", now)).toBeCloseTo(41 / 20);
  expect(burnPerHour(window, "6h", now)).toBeCloseTo(1 / 6);
  expect(burnPerHour(null, "3h", now)).toBe(0);
});

test("pace compares use against the share of the window gone", () => {
  const halfWay = start + 3.5 * dayMs;
  expect(paceOf(windowOf([[0, 80]]), halfWay)).toEqual({ pace: "ahead", elapsedShare: 0.5 });
  expect(paceOf(windowOf([[0, 52]]), halfWay)?.pace).toBe("on");
  expect(paceOf(windowOf([[0, 10]]), halfWay)?.pace).toBe("under");
});

test("a slow burn expires quota at the reset and refills", () => {
  const open = windowOf([[0, 80]]);
  const nowMs = start + 6 * dayMs;
  const projection = projectLimit({
    open,
    windowMinutes: 10_080,
    nowMs,
    burn: 0.5,
    untilMs: start + 8 * dayMs,
  });
  expect(projection.emptyAtMs).toBeNull();
  expect(projection.remainingAtReset).toBeCloseTo(8);
  expect(projection.jumps).toEqual([{ tMs: start + 7 * dayMs, gain: expect.closeTo(92) }]);
  expect(projection.points.at(-1)?.remaining).toBeCloseTo(88);
});

test("a fast burn hits zero before the reset and waits there", () => {
  const nowMs = start + 6 * dayMs;
  const projection = projectLimit({
    open: windowOf([[0, 80]]),
    windowMinutes: 10_080,
    nowMs,
    burn: 2,
    untilMs: start + 7.5 * dayMs,
  });
  expect(projection.emptyAtMs).toBe(nowMs + 10 * hourMs);
  expect(projection.remainingAtReset).toBe(0);
  expect(projection.jumps).toEqual([{ tMs: start + 7 * dayMs, gain: 100 }]);
});

test("recorded rows hold the last reading until now, then the projection takes over", () => {
  const open = windowOf([
    [0, 10],
    [2, 30],
  ]);
  const nowMs = start + 4 * hourMs;
  const span = { fromMs: start - hourMs, toMs: start + 6 * hourMs };
  const projection = projectLimit({
    open,
    windowMinutes: 10_080,
    nowMs,
    burn: 1,
    untilMs: span.toMs,
  });
  const { rows } = chartRowsOf({ windows: [open], projection, span, nowMs, stepMs: hourMs });
  const at = (hours: number) => rows.filter((row) => row.t === start + hours * hourMs);
  expect(at(-1)).toEqual([]);
  expect(at(3)[0]).toEqual({ t: start + 3 * hourMs, recorded: 70, projected: null });
  expect(at(4)[0]).toEqual({ t: nowMs, recorded: 70, projected: 70 });
  expect(at(5)[0]?.projected).toBeCloseTo(69);
});

test("a closed window jumps back to full where it ended", () => {
  const closed: LimitWindow = {
    ...windowOf([
      [0, 10],
      [2, 30],
    ]),
    outcome: "replaced",
    endedAt: iso(start + 3 * hourMs),
  };
  const nowMs = start + 4 * hourMs;
  const span = { fromMs: start, toMs: nowMs };
  const projection = projectLimit({
    open: null,
    windowMinutes: 10_080,
    nowMs,
    burn: 0,
    untilMs: span.toMs,
  });
  const { rows, jumps } = chartRowsOf({
    windows: [closed],
    projection,
    span,
    nowMs,
    stepMs: hourMs,
  });
  expect(jumps).toEqual([{ tMs: start + 3 * hourMs, gain: 30 }]);
  expect(rows.at(-1)?.recorded).toBe(100);
});

test("readings close together form one burst, and a quiet gap only counts its end", () => {
  const bursts = drainBurstsOf([
    windowOf([
      [0, 0],
      [0.25, 10],
      [0.5, 25],
      [10, 30],
    ]),
  ]);
  expect(bursts).toEqual([
    { fromMs: start, toMs: start + 0.5 * hourMs, drop: 25 },
    { fromMs: start + 10 * hourMs - 0.75 * hourMs, toMs: start + 10 * hourMs, drop: 5 },
  ]);
});

const limitsOf = (provider: ProviderLimits["provider"], window: LimitWindow): ProviderLimits => ({
  provider,
  plan: null,
  series: [{ windowMinutes: 10_080, windows: [window] }],
  hits: [],
});

test("use first names the limit that resets first, unless it is nearly gone", () => {
  const soon = { ...windowOf([[0, 68]]), resetsAt: iso(start + dayMs) };
  const later = { ...windowOf([[0, 20]]), resetsAt: iso(start + 4 * dayMs) };
  expect(useFirstOf([limitsOf("claude", later), limitsOf("codex", soon)])).toEqual({
    provider: "codex",
    remaining: 32,
    resetsAtMs: start + dayMs,
    thenProvider: "claude",
    thenResetsAtMs: start + 4 * dayMs,
  });
  expect(useFirstOf([limitsOf("codex", soon)])).toBeNull();
  const blocked = limitsOf("codex", soon);
  const short = {
    windowMinutes: 300,
    windows: [{ ...soon, windowMinutes: 300, usedPercent: 100 }],
  };
  expect(
    useFirstOf([limitsOf("claude", later), { ...blocked, series: [...blocked.series, short] }]),
  ).toBeNull();
  const spent = { ...soon, usedPercent: 98 };
  expect(useFirstOf([limitsOf("claude", later), limitsOf("codex", spent)])).toBeNull();
});

test("recent burn uses only the observed part of a young window", () => {
  const window = windowOf([
    [0, 0],
    [1, 10],
  ]);
  for (const mode of ["1h", "3h", "6h"] as const) {
    expect(burnPerHour(window, mode, start + hourMs)).toBeCloseTo(10);
    expect(burnPerHour(window, mode, start + hourMs / 4)).toBe(0);
  }
});

test("short-window history pages are contiguous and fit inside the requested span", () => {
  for (const week of [0, -1, -2]) {
    const short = spanFor(300, week, start);
    const earlier = spanFor(300, week - 1, start);
    const loaded = spanFor(10_080, week, start);
    expect(earlier.toMs).toBe(short.fromMs);
    expect(short.fromMs).toBeGreaterThanOrEqual(loaded.fromMs);
    expect(short.toMs).toBeLessThanOrEqual(loaded.toMs);
  }
});

test("an exhausted window is empty now even with no future burn", () => {
  for (const burn of [0, 10]) {
    const nowMs = start + hourMs;
    const projection = projectLimit({
      open: windowOf([[0, 100]]),
      windowMinutes: 10_080,
      nowMs,
      burn,
      untilMs: start + 8 * dayMs,
    });
    expect(projection.emptyAtMs).toBe(nowMs);
    expect(projection.remainingAtReset).toBe(0);
  }
});

test("daily chart ticks stay at local midnight across a DST change", () => {
  vi.stubEnv("TZ", "Europe/Berlin");
  try {
    const ticks = dayTicksOf({
      fromMs: new Date(2026, 9, 24).getTime(),
      toMs: new Date(2026, 9, 27).getTime(),
    });
    expect(ticks.map((ms) => new Date(ms).getDate())).toEqual([24, 25, 26, 27]);
    expect(ticks.map((ms) => new Date(ms).getHours())).toEqual([0, 0, 0, 0]);
    expect((ticks[2] ?? 0) - (ticks[1] ?? 0)).toBe(25 * hourMs);
  } finally {
    vi.unstubAllEnvs();
  }
});
