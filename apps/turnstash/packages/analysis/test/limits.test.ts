import { expect, test } from "vite-plus/test";

import { collapseLimitHits, limitWindowsOf } from "../src/limits.ts";

const week = 10_080;
const hour = 3_600_000;
const day = 24 * hour;
const start = Date.UTC(2026, 9, 25);

const reading = (hours: number, usedPercent: number, resetsAtMs: number) => ({
  observedAtMs: start + hours * hour,
  usedPercent,
  resetsAtMs,
});

test("readings whose reset differs by seconds are one window, and only a rising value adds a point", () => {
  const resetsAtMs = start + 7 * day;
  const [window, ...rest] = limitWindowsOf(
    week,
    [
      reading(0, 10, resetsAtMs),
      reading(1, 20, resetsAtMs + 4_000),
      reading(2, 15, resetsAtMs - 3_000),
      reading(3, 30, resetsAtMs + 1_000),
    ],
    start + 4 * hour,
  );
  expect(rest).toEqual([]);
  expect(window?.outcome).toBe("open");
  expect(window?.usedPercent).toBe(30);
  expect(window?.points.map((point) => point.usedPercent)).toEqual([10, 20, 30]);
});

test("a window ends at its reset, or where a later window took over early", () => {
  const firstReset = start + 7 * day;
  const secondReset = start + 8 * day;
  const windows = limitWindowsOf(
    week,
    [
      reading(0, 10, firstReset),
      reading(5, 40, firstReset),
      reading(25, 1, secondReset),
      reading(26, 9, secondReset),
    ],
    start + 10 * day,
  );
  expect(windows.map((window) => window.outcome)).toEqual(["replaced", "reset"]);
  expect(windows[0]?.endedAtMs).toBe(secondReset - 7 * day);
  expect(windows[1]?.endedAtMs).toBe(secondReset);
});

test("a reading taken after its own reset is dropped as replayed history", () => {
  const resetsAtMs = start + 7 * day;
  const windows = limitWindowsOf(
    week,
    [reading(1, 10, resetsAtMs), reading(24 * 9, 90, resetsAtMs)],
    start + 10 * day,
  );
  expect(windows).toHaveLength(1);
  expect(windows[0]?.usedPercent).toBe(10);
});

test("limit hits within half an hour of each other collapse into one marker", () => {
  const hit = (minutes: number, windowMinutes: number | null = 300) => ({
    atMs: start + minutes * 60_000,
    windowMinutes,
    message: "You've hit your session limit",
  });
  expect(
    collapseLimitHits([hit(45), hit(0), hit(20), hit(200), hit(205, 10_080)]).map((marker) => [
      marker.atMs,
      marker.count,
    ]),
  ).toEqual([
    [start, 3],
    [start + 200 * 60_000, 1],
    [start + 205 * 60_000, 1],
  ]);
});
