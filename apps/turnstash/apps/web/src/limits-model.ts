import type { LimitSeries, LimitWindow, ProviderId, ProviderLimits } from "@aqt/turnstash-api";

export const hourMs = 3_600_000;
export const dayMs = 24 * hourMs;

export type BurnMode = "window" | "6h" | "3h" | "1h";
export type FutureUsage = "same" | "half" | "double" | "none";

export const futureFactors: Record<FutureUsage, number> = {
  same: 1,
  half: 0.5,
  double: 2,
  none: 0,
};

const burnHours: Record<Exclude<BurnMode, "window">, number> = { "6h": 6, "3h": 3, "1h": 1 };

const atMs = (iso: string) => Date.parse(iso);

export const windowLabel = (windowMinutes: number): string => {
  if (windowMinutes === 10_080) return "Weekly";
  if (windowMinutes === 300) return "5-hour";
  return `${Math.round(windowMinutes / 60)}-hour`;
};

export interface LimitSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

export const dayTicksOf = (span: LimitSpan): ReadonlyArray<number> => {
  const ticks: Array<number> = [];
  const date = new Date(span.fromMs);
  for (; date.getTime() <= span.toMs; date.setDate(date.getDate() + 1)) ticks.push(date.getTime());
  return ticks;
};

// Pages move by a week. Short-window charts use contiguous weeks within the longer query span.
export const spanFor = (windowMinutes: number, weekOffset: number, nowMs: number): LimitSpan => {
  const day = (offset: number) => {
    const date = new Date(nowMs);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + weekOffset * 7 + offset);
    return date.getTime();
  };
  return windowMinutes >= 7 * 24 * 60
    ? { fromMs: day(-8), toMs: day(6) }
    : { fromMs: day(-6), toMs: day(1) };
};

export const openWindowOf = (series: LimitSeries): LimitWindow | null =>
  series.windows.findLast((window) => window.outcome === "open") ?? null;

const usedAt = (window: LimitWindow, ms: number): number => {
  let used = window.firstUsedPercent;
  for (const point of window.points) {
    if (atMs(point.at) > ms) break;
    used = point.usedPercent;
  }
  return used;
};

export const burnPerHour = (window: LimitWindow | null, mode: BurnMode, nowMs: number): number => {
  if (window === null) return 0;
  const risen = window.usedPercent - window.firstUsedPercent;
  if (mode === "window" || window.points.length === 0) {
    const hours = (nowMs - atMs(window.firstObservedAt)) / hourMs;
    return hours > 0.25 ? risen / hours : 0;
  }
  const hours = Math.min(burnHours[mode], (nowMs - atMs(window.firstObservedAt)) / hourMs);
  if (hours <= 0.25) return 0;
  return Math.max(0, window.usedPercent - usedAt(window, nowMs - hours * hourMs)) / hours;
};

export type Pace = "ahead" | "on" | "under";

export interface PaceReading {
  readonly pace: Pace;
  readonly elapsedShare: number;
}

export const paceOf = (window: LimitWindow | null, nowMs: number): PaceReading | null => {
  if (window === null) return null;
  const startsAt = atMs(window.startsAt);
  const elapsedShare = Math.min(1, (nowMs - startsAt) / (atMs(window.resetsAt) - startsAt));
  const gap = window.usedPercent - elapsedShare * 100;
  return { pace: gap > 5 ? "ahead" : gap < -5 ? "under" : "on", elapsedShare };
};

export interface ChartMark {
  readonly tMs: number;
  readonly remaining: number;
}

export interface LimitJump {
  readonly tMs: number;
  readonly gain: number;
}

export interface Projection {
  readonly points: ReadonlyArray<ChartMark>;
  readonly jumps: ReadonlyArray<LimitJump>;
  readonly emptyAtMs: number | null;
  readonly remainingAtReset: number | null;
}

export const projectLimit = ({
  open,
  windowMinutes,
  nowMs,
  burn,
  untilMs,
}: {
  readonly open: LimitWindow | null;
  readonly windowMinutes: number;
  readonly nowMs: number;
  readonly burn: number;
  readonly untilMs: number;
}): Projection => {
  if (open === null)
    return {
      points:
        nowMs >= untilMs
          ? []
          : [
              { tMs: nowMs, remaining: 100 },
              { tMs: untilMs, remaining: 100 },
            ],
      jumps: [],
      emptyAtMs: null,
      remainingAtReset: null,
    };
  const windowMs = windowMinutes * 60_000;
  const left = 100 - open.usedPercent;
  const firstResetMs = atMs(open.resetsAt);
  const firstZeroMs =
    left <= 0 ? nowMs : burn > 0 ? nowMs + (left / burn) * hourMs : Number.POSITIVE_INFINITY;
  const emptyAtMs = firstZeroMs < firstResetMs ? firstZeroMs : null;
  const remainingAtReset =
    emptyAtMs === null ? Math.max(0, left - (burn * (firstResetMs - nowMs)) / hourMs) : 0;
  const points: Array<ChartMark> = [];
  const jumps: Array<LimitJump> = [];
  if (nowMs < untilMs) points.push({ tMs: nowMs, remaining: left });
  let remaining = left;
  let tMs = nowMs;
  let resetMs = firstResetMs;
  while (tMs < untilMs) {
    const endMs = Math.min(resetMs, untilMs);
    const zeroMs = burn > 0 ? tMs + (remaining / burn) * hourMs : Number.POSITIVE_INFINITY;
    let atEnd = remaining - (burn * (endMs - tMs)) / hourMs;
    if (zeroMs < endMs) {
      points.push({ tMs: zeroMs, remaining: 0 });
      atEnd = 0;
    }
    points.push({ tMs: endMs, remaining: atEnd });
    if (resetMs >= untilMs) break;
    jumps.push({ tMs: resetMs, gain: 100 - atEnd });
    points.push({ tMs: resetMs, remaining: 100 });
    remaining = 100;
    tMs = resetMs;
    resetMs += windowMs;
  }
  return { points, jumps, emptyAtMs, remainingAtReset };
};

export interface ChartRow {
  readonly t: number;
  readonly recorded: number | null;
  readonly projected: number | null;
}

const recordedMarks = (windows: ReadonlyArray<LimitWindow>, nowMs: number) => {
  const marks: Array<ChartMark> = [];
  const jumps: Array<LimitJump> = [];
  for (const window of windows) {
    for (const point of window.points)
      marks.push({ tMs: atMs(point.at), remaining: 100 - point.usedPercent });
    const endedAt = atMs(window.endedAt);
    if (window.outcome !== "open" && window.points.length > 0 && endedAt <= nowMs) {
      marks.push({ tMs: endedAt, remaining: 100 });
      jumps.push({ tMs: endedAt, gain: window.usedPercent });
    }
  }
  return { marks: marks.toSorted((a, b) => a.tMs - b.tMs), jumps };
};

const projectedOn = (points: ReadonlyArray<ChartMark>, tMs: number): number | null => {
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    if (before === undefined || after === undefined || after.tMs === before.tMs) continue;
    if (tMs >= before.tMs && tMs <= after.tMs)
      return (
        before.remaining +
        ((after.remaining - before.remaining) * (tMs - before.tMs)) / (after.tMs - before.tMs)
      );
  }
  return null;
};

// The regular steps give the crosshair something to land on between readings, which can be days apart.
export const chartRowsOf = ({
  windows,
  projection,
  span,
  nowMs,
  stepMs,
}: {
  readonly windows: ReadonlyArray<LimitWindow>;
  readonly projection: Projection;
  readonly span: LimitSpan;
  readonly nowMs: number;
  readonly stepMs: number;
}) => {
  const { marks, jumps } = recordedMarks(windows, nowMs);
  const inSpan = (tMs: number) => tMs >= span.fromMs && tMs <= span.toMs;
  const firstRecorded = marks.at(0)?.tMs ?? Number.POSITIVE_INFINITY;
  const rows: Array<ChartRow> = [];
  const grid: Array<number> = [];
  for (let tMs = span.fromMs; tMs <= span.toMs; tMs += stepMs) grid.push(tMs);
  const recordedTimes = [...grid, ...marks.map((mark) => mark.tMs), nowMs].filter(
    (tMs) => inSpan(tMs) && tMs <= nowMs && tMs >= firstRecorded,
  );
  let markIndex = 0;
  let remaining: number | null = null;
  for (const tMs of [...new Set(recordedTimes)].toSorted((a, b) => a - b)) {
    while (markIndex < marks.length) {
      const mark = marks[markIndex];
      if (mark === undefined || mark.tMs > tMs) break;
      remaining = mark.remaining;
      markIndex += 1;
    }
    rows.push({
      t: tMs,
      recorded: remaining,
      projected: tMs === nowMs ? (projection.points[0]?.remaining ?? null) : null,
    });
  }
  for (const tMs of grid) {
    if (tMs <= nowMs) continue;
    rows.push({ t: tMs, recorded: null, projected: projectedOn(projection.points, tMs) });
  }
  for (const point of projection.points) {
    if (point.tMs <= nowMs || !inSpan(point.tMs)) continue;
    rows.push({ t: point.tMs, recorded: null, projected: point.remaining });
  }
  // A stable sort keeps the two rows of a reset in order: the level before it, then the refill.
  return {
    rows: rows.toSorted((a, b) => a.t - b.t),
    jumps: jumps.filter((jump) => inSpan(jump.tMs)),
  };
};

export interface DrainBurst {
  readonly fromMs: number;
  readonly toMs: number;
  readonly drop: number;
}

const burstGapMs = 45 * 60_000;

// Usage rose after the earlier reading and by the later one. Encode that interval as [from, to).
export const drainBurstsOf = (windows: ReadonlyArray<LimitWindow>): ReadonlyArray<DrainBurst> => {
  const bursts: Array<DrainBurst> = [];
  for (const window of windows) {
    let latest: DrainBurst | null = null;
    for (let index = 1; index < window.points.length; index += 1) {
      const before = window.points[index - 1];
      const after = window.points[index];
      if (before === undefined || after === undefined) continue;
      const beforeMs = atMs(before.at);
      const afterMs = atMs(after.at);
      const drop = after.usedPercent - before.usedPercent;
      if (latest !== null && afterMs - latest.toMs <= burstGapMs) {
        latest = { fromMs: latest.fromMs, toMs: afterMs + 1, drop: latest.drop + drop };
        bursts[bursts.length - 1] = latest;
      } else {
        latest = { fromMs: beforeMs + 1, toMs: afterMs + 1, drop };
        bursts.push(latest);
      }
    }
  }
  return bursts.toSorted((a, b) => b.drop - a.drop);
};

export interface DrainBucket {
  readonly t: number;
  readonly rate: number;
}

export const drainBucketsOf = (
  windows: ReadonlyArray<LimitWindow>,
  span: LimitSpan,
  bucketMs: number,
  nowMs: number,
): ReadonlyArray<DrainBucket> => {
  const endMs = Math.min(span.toMs, nowMs);
  const buckets = new Map<number, number>();
  for (let t = span.fromMs; t < endMs; t += bucketMs) buckets.set(t, 0);
  for (const window of windows) {
    for (let index = 1; index < window.points.length; index += 1) {
      const before = window.points[index - 1];
      const after = window.points[index];
      if (before === undefined || after === undefined) continue;
      const tMs = atMs(after.at);
      if (tMs < span.fromMs || tMs >= endMs) continue;
      const bucket = span.fromMs + Math.floor((tMs - span.fromMs) / bucketMs) * bucketMs;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + after.usedPercent - before.usedPercent);
    }
  }
  return [...buckets].map(([t, drop]) => ({
    t,
    rate: drop / (Math.min(bucketMs, span.toMs - t, Math.max(endMs - t, hourMs)) / hourMs),
  }));
};

export const latestCostPerPercent = (series: LimitSeries): number | null =>
  series.windows.findLast((window) => window.costPerPercentUsd !== null)?.costPerPercentUsd ?? null;

export const expiredByProvider = (
  providers: ReadonlyArray<ProviderLimits>,
  range: { readonly fromMs: number; readonly toMs: number } | null,
) =>
  new Map(
    providers.map((limits) => {
      const totals = new Map<string, number>();
      for (const series of limits.series)
        for (const window of series.windows) {
          const resetMs = atMs(window.resetsAt);
          if (range !== null && (resetMs < range.fromMs || resetMs >= range.toMs)) continue;
          for (const { currency, amount } of window.expiredValue)
            totals.set(currency, (totals.get(currency) ?? 0) + amount);
        }
      return [
        limits.provider,
        [...totals].map(([currency, amount]) => ({ currency, amount })),
      ] as const;
    }),
  );

export interface UseFirst {
  readonly provider: ProviderId;
  readonly remaining: number;
  readonly resetsAtMs: number;
  readonly thenProvider: ProviderId;
  readonly thenResetsAtMs: number;
}

const usefulRemaining = 5;

// The manual form of soonest-reset-first routing: what expires first is what to spend first.
export const useFirstOf = (providers: ReadonlyArray<ProviderLimits>): UseFirst | null => {
  const open = providers
    .flatMap((limits) => {
      if (
        limits.series.some((series) => {
          const current = openWindowOf(series);
          return current !== null && 100 - current.usedPercent < usefulRemaining;
        })
      )
        return [];
      const longest = limits.series.at(0);
      const window = longest === undefined ? null : openWindowOf(longest);
      return window === null
        ? []
        : [
            {
              provider: limits.provider,
              remaining: 100 - window.usedPercent,
              resetsAtMs: atMs(window.resetsAt),
            },
          ];
    })
    .toSorted((a, b) => a.resetsAtMs - b.resetsAtMs);
  const [first, then] = open;
  if (first === undefined || then === undefined) return null;
  return { ...first, thenProvider: then.provider, thenResetsAtMs: then.resetsAtMs };
};
