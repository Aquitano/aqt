import type { CurrentLimitsReport, LimitWindow } from "@aqt/turnstash-api";
import { expect, test } from "vite-plus/test";

import { hourMs } from "../src/limits-model";
import { quotaAlertsOf } from "../src/quota/alerts";
import { defaultPreferences } from "../src/quota/storage";

const now = Date.UTC(2026, 10, 5, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const enabled = { low: true, unused: true, desktop: false };
const windowOf = (patch: Partial<LimitWindow> = {}): LimitWindow => ({
  windowMinutes: 300,
  startsAt: iso(now - 3 * hourMs),
  resetsAt: iso(now + 2 * hourMs),
  endedAt: iso(now + 2 * hourMs),
  outcome: "open",
  firstObservedAt: iso(now - hourMs),
  lastObservedAt: iso(now),
  firstUsedPercent: 60,
  usedPercent: 90,
  costUsd: 0,
  requests: 0,
  costPerPercentUsd: null,
  expiredValue: [],
  points: [
    { at: iso(now - hourMs), usedPercent: 60 },
    { at: iso(now), usedPercent: 90 },
  ],
  ...patch,
});
const reportOf = (...windows: ReadonlyArray<LimitWindow>): CurrentLimitsReport => ({
  generatedAt: iso(now),
  providers: [
    {
      provider: "claude",
      windows,
    },
  ],
});

test("alerts default off, and each rule is independently optional", () => {
  const report = reportOf(windowOf());
  expect(quotaAlertsOf(report, defaultPreferences, now)).toEqual([]);
  expect(quotaAlertsOf(report, { ...enabled, low: false }, now)).toEqual([]);
  expect(quotaAlertsOf(report, enabled, now)).toMatchObject([
    { kind: "low", provider: "claude", windowMinutes: 300 },
  ]);
});

test("low quota includes the threshold and exhaustion without requiring a burn history", () => {
  const idle = windowOf({ points: [], firstUsedPercent: 90 });
  expect(quotaAlertsOf(reportOf(idle), enabled, now)[0]?.description).toContain("10% left");
  expect(quotaAlertsOf(reportOf({ ...idle, usedPercent: 89 }), enabled, now)).toEqual([]);
  expect(quotaAlertsOf(reportOf({ ...idle, usedPercent: 100 }), enabled, now)[0]?.title).toContain(
    "is exhausted",
  );
});

test("a fast recent burn warns only when exhaustion precedes the reset within an hour", () => {
  const fast = windowOf({
    usedPercent: 80,
    points: [
      { at: iso(now - hourMs), usedPercent: 40 },
      { at: iso(now), usedPercent: 80 },
    ],
  });
  expect(quotaAlertsOf(reportOf(fast), enabled, now)[0]?.description).toContain(
    "may run out within an hour",
  );
  expect(
    quotaAlertsOf(reportOf({ ...fast, resetsAt: iso(now + hourMs / 4) }), enabled, now),
  ).toEqual([]);
  const slow = {
    ...fast,
    points: [
      { at: iso(now - hourMs), usedPercent: 75 },
      { at: iso(now), usedPercent: 80 },
    ],
  };
  expect(quotaAlertsOf(reportOf(slow), enabled, now)).toEqual([]);
});

test("unused quota requires enough history, at least 20% projected left and a reset within an hour", () => {
  const unused = windowOf({
    usedPercent: 60,
    resetsAt: iso(now + hourMs),
    points: [
      { at: iso(now - hourMs), usedPercent: 40 },
      { at: iso(now), usedPercent: 60 },
    ],
  });
  expect(quotaAlertsOf(reportOf(unused), enabled, now)).toMatchObject([{ kind: "unused" }]);
  const idle = {
    ...unused,
    firstUsedPercent: 60,
    points: [{ at: iso(now - hourMs), usedPercent: 60 }],
  };
  expect(quotaAlertsOf(reportOf(idle), enabled, now)).toMatchObject([{ kind: "unused" }]);
  expect(quotaAlertsOf(reportOf(unused), { ...enabled, unused: false }, now)).toEqual([]);
  expect(
    quotaAlertsOf(reportOf({ ...unused, resetsAt: iso(now + hourMs + 1) }), enabled, now),
  ).toEqual([]);
  expect(quotaAlertsOf(reportOf({ ...unused, usedPercent: 61 }), enabled, now)).toEqual([]);
  expect(quotaAlertsOf(reportOf({ ...unused, points: [] }), enabled, now)).toEqual([]);
  expect(
    quotaAlertsOf(reportOf({ ...unused, firstObservedAt: iso(now - 5 * 60_000) }), enabled, now),
  ).toEqual([]);
});

test("an exhausted short window suppresses an unused weekly quota suggestion", () => {
  const weekly = windowOf({
    windowMinutes: 10_080,
    usedPercent: 60,
    resetsAt: iso(now + hourMs / 2),
  });
  const alerts = quotaAlertsOf(reportOf(weekly, windowOf({ usedPercent: 100 })), enabled, now);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ kind: "low", windowMinutes: 300 });
});

test("stale reports, stale observations and elapsed or closed windows cannot alert", () => {
  const report = reportOf(windowOf());
  expect(quotaAlertsOf({ ...report, generatedAt: iso(now - 11 * 60_000) }, enabled, now)).toEqual(
    [],
  );
  expect(quotaAlertsOf({ ...report, generatedAt: iso(now + 2 * 60_000) }, enabled, now)).toEqual(
    [],
  );
  for (const patch of [
    { lastObservedAt: iso(now - 31 * 60_000) },
    { lastObservedAt: iso(now + 2 * 60_000) },
    { resetsAt: iso(now) },
    { outcome: "reset" as const },
  ])
    expect(quotaAlertsOf(reportOf(windowOf(patch)), enabled, now)).toEqual([]);
});

test("reset timestamp drift preserves an alert identity but a new window has a new identity", () => {
  const first = quotaAlertsOf(reportOf(windowOf()), enabled, now)[0];
  const drift = quotaAlertsOf(
    reportOf(windowOf({ resetsAt: iso(now + 2 * hourMs + 1000) })),
    enabled,
    now,
  )[0];
  const next = quotaAlertsOf(reportOf(windowOf({ firstObservedAt: iso(now) })), enabled, now)[0];
  expect(first?.id).toBe(drift?.id);
  expect(first?.id).not.toBe(next?.id);
});
