import type { BuiltLimitWindow } from "./limits.ts";

const hourMs = 3_600_000;
export const quotaObservationMaxAgeMs = 30 * 60_000;

export const quotaStateOf = (open: BuiltLimitWindow, nowMs: number, blocked: boolean) => {
  const ageMs = nowMs - open.lastObservedAtMs;
  const fresh =
    open.outcome === "open" &&
    open.resetsAtMs > nowMs &&
    ageMs >= -60_000 &&
    ageMs <= quotaObservationMaxAgeMs;
  const remainingPercent = 100 - open.usedPercent;
  const canProject =
    open.points.length > 0 && open.lastObservedAtMs - open.firstObservedAtMs > hourMs / 4;
  const hours = Math.min(1, (nowMs - open.firstObservedAtMs) / hourMs);
  const sinceMs = nowMs - hours * hourMs;
  let usedBefore = open.firstUsedPercent;
  for (const point of open.points) {
    if (point.atMs > sinceMs) break;
    usedBefore = point.usedPercent;
  }
  const burn = hours > 0.25 ? Math.max(0, open.usedPercent - usedBefore) / hours : 0;
  const emptyAtMs =
    remainingPercent <= 0
      ? nowMs
      : burn > 0
        ? nowMs + (remainingPercent / burn) * hourMs
        : Infinity;
  const remainingAtReset = Math.max(
    0,
    remainingPercent - (burn * (open.resetsAtMs - nowMs)) / hourMs,
  );
  const runningOut = canProject && emptyAtMs < open.resetsAtMs && emptyAtMs <= nowMs + hourMs;
  return {
    fresh,
    remainingPercent,
    remainingAtReset,
    canProject,
    runningOut,
    low: fresh && (remainingPercent <= 10 || runningOut),
    unused:
      fresh &&
      !blocked &&
      canProject &&
      open.resetsAtMs <= nowMs + hourMs &&
      remainingAtReset >= 20,
  };
};
