import { expect, test } from "bun:test";

import { claudeLimitReadings } from "../src/limits.ts";

const fetchedAtMs = Date.UTC(2026, 10, 5, 11, 48);

test("reads the session and weekly windows and nothing else from Claude's state file", () => {
  const readings = claudeLimitReadings(
    JSON.stringify({
      oauthAccount: { organizationRateLimitTier: "default_claude_max_5x", emailAddress: "a@b.c" },
      cachedUsageUtilization: {
        fetchedAtMs,
        accountUuid: "cd7d976f-5376-49b8-b1e0-a88a12f6af96",
        utilization: {
          five_hour: { utilization: 20, resets_at: "2026-11-05T12:40:00.810473+00:00" },
          seven_day: { utilization: 124, resets_at: "2026-11-09T21:00:00.810501+00:00" },
          seven_day_opus: null,
        },
      },
    }),
  );
  expect(readings).toEqual([
    {
      provider: "claude",
      windowMinutes: 300,
      observedAt: "2026-11-05T11:48:00.000Z",
      usedPercent: 20,
      resetsAt: "2026-11-05T12:40:00.810Z",
      plan: "default_claude_max_5x",
    },
    {
      provider: "claude",
      windowMinutes: 10_080,
      observedAt: "2026-11-05T11:48:00.000Z",
      usedPercent: 100,
      resetsAt: "2026-11-09T21:00:00.810Z",
      plan: "default_claude_max_5x",
    },
  ]);
});

test("yields no readings without a usable cache", () => {
  expect(claudeLimitReadings("")).toEqual([]);
  expect(claudeLimitReadings(JSON.stringify({ oauthAccount: null }))).toEqual([]);
  expect(
    claudeLimitReadings(
      JSON.stringify({
        cachedUsageUtilization: {
          fetchedAtMs,
          utilization: { five_hour: { utilization: 20, resets_at: null } },
        },
      }),
    ),
  ).toEqual([]);
});
