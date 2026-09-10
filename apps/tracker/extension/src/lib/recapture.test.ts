import { describe, expect, test } from "bun:test";

import { RECAPTURE_MIN_INTERVAL_MS, recaptureDecision } from "./recapture.ts";

describe("recaptureDecision", () => {
  const afterQuiet = { recapture: "after_quiet" };
  const capturedAt = "2026-09-09T10:00:00.000Z";
  const captured = Date.parse(capturedAt);

  test("recaptures once the minimum interval has passed", () => {
    expect(
      recaptureDecision({
        rule: afterQuiet,
        lastCapturedAt: capturedAt,
        now: captured + RECAPTURE_MIN_INTERVAL_MS,
      }),
    ).toEqual({ kind: "now" });
  });

  test("defers to the end of the interval when the page settles too early", () => {
    expect(
      recaptureDecision({
        rule: afterQuiet,
        lastCapturedAt: capturedAt,
        now: captured + 50_000,
      }),
    ).toEqual({ kind: "defer", due: captured + RECAPTURE_MIN_INTERVAL_MS });
  });

  test("never recaptures a page view that was never captured", () => {
    expect(
      recaptureDecision({ rule: afterQuiet, lastCapturedAt: undefined, now: Date.now() }),
    ).toEqual({ kind: "never" });
  });

  test("never recaptures rules that opt out, or pages with no rule", () => {
    const now = captured + RECAPTURE_MIN_INTERVAL_MS;
    expect(
      recaptureDecision({ rule: { recapture: "never" }, lastCapturedAt: capturedAt, now }),
    ).toEqual({ kind: "never" });
    expect(recaptureDecision({ rule: undefined, lastCapturedAt: capturedAt, now })).toEqual({
      kind: "never",
    });
  });
});
