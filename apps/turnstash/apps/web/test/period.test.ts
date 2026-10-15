import { describe, expect, test } from "vite-plus/test";

import { duration } from "../src/format.ts";
import {
  dateBounds,
  heatmapDays,
  heatmapRange,
  heatmapWeeks,
  periodRange,
  previousRange,
  withQuietDays,
  ymd,
} from "../src/period.ts";

const march15 = new Date(2026, 2, 15);

test("local day bounds preserve UTC offsets and both DST transitions", () => {
  // Node keeps the last zone after `delete process.env.TZ`, so restore by assignment.
  const zone = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    for (const [timeZone, day, from, to] of [
      ["Europe/Berlin", "2026-10-09", "2026-10-08T22:00:00.000Z", "2026-10-09T22:00:00.000Z"],
      ["Europe/Berlin", "2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
      ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
    ] as const) {
      process.env.TZ = timeZone;
      expect(dateBounds({ from: day, to: day })).toEqual({ from, to });
    }
  } finally {
    process.env.TZ = zone;
  }
});

describe("periodRange", () => {
  test("all time has no bounds", () => {
    expect(periodRange("all", march15)).toBeNull();
  });

  test("today is a single inclusive day", () => {
    expect(periodRange("today", march15)).toEqual({ from: "2026-03-15", to: "2026-03-15" });
  });

  test("rolling periods include exactly the labelled number of days", () => {
    expect(periodRange("7d", march15)).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(periodRange("30d", march15)).toEqual({ from: "2026-02-14", to: "2026-03-15" });
  });

  test("month starts on the first", () => {
    expect(periodRange("month", march15)).toEqual({ from: "2026-03-01", to: "2026-03-15" });
  });
});

test("previousRange is the same length and ends the day before", () => {
  expect(previousRange({ from: "2026-03-08", to: "2026-03-15" })).toEqual({
    from: "2026-02-28",
    to: "2026-03-07",
  });
});

test("heatmapRange covers 52 weeks back from today", () => {
  expect(heatmapRange(march15)).toEqual({ from: "2025-03-16", to: "2026-03-15" });
});

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

describe("heatmapDays", () => {
  test("every week runs Monday to Sunday and the last one holds today", () => {
    for (const now of [new Date(2026, 2, 15), new Date(2026, 2, 16), new Date(2026, 2, 19)]) {
      const weeks = heatmapDays(now);
      expect(weeks).toHaveLength(heatmapWeeks);
      for (const week of weeks) expect(week.map(weekdayOf)).toEqual([1, 2, 3, 4, 5, 6, 0]);
      expect(weeks.at(-1)).toContain(ymd(now));
    }
  });

  test("days stay consecutive across a daylight-saving change", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      const days = heatmapDays(new Date(2026, 9, 8)).flat();
      const steps = days
        .slice(1)
        .map((day, index) => Date.parse(day) - Date.parse(days[index] ?? ""));
      expect(days).toContain("2025-10-26");
      expect(new Set(steps)).toEqual(new Set([86_400_000]));
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

const recordedDay = (date: string, costUsd: number) => ({
  date,
  requests: 1,
  conversations: 1,
  costUsd,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

test("withQuietDays fills the days between recorded ones with zeros", () => {
  const days = withQuietDays([recordedDay("2026-10-30", 2), recordedDay("2026-11-02", 5)]);
  expect(days.map((row) => [row.date, row.costUsd])).toEqual([
    ["2026-10-30", 2],
    ["2026-10-31", 0],
    ["2026-11-01", 0],
    ["2026-11-02", 5],
  ]);
});

describe("format", () => {
  test("duration reports minutes and seconds", () => {
    expect(duration("2026-03-15T10:00:00Z", "2026-03-15T10:02:13Z")).toBe("2m 13s");
  });
});
