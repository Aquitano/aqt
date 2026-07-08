import type {
  ActivitySummariesResponse,
  BodyMeasurementsResponse,
  HrvSamplesResponse,
  RespiratoryRateSamplesResponse,
  SleepSummariesResponse,
  StepDailySummariesResponse,
} from "./types";

export type TrendPoint = {
  /** Calendar day, YYYY-MM-DD. */
  date: string;
  value: number;
};

export type TrendChange = {
  abs: number;
  pct: number | null;
};

export type TrendStat = {
  key: string;
  label: string;
  unit: string;
  /** CSS color token, e.g. var(--hue-weight). */
  color: string;
  /** Which direction is healthier, used only to tint the change chips. */
  goodWhen: "up" | "down" | null;
  /** One value per calendar day, ascending. */
  points: TrendPoint[];
  latest: number | null;
  latestAt: string | null;
  average: number | null;
  min: number | null;
  max: number | null;
  change7d: TrendChange | null;
  change30d: TrendChange | null;
};

type AggregateMode = "last" | "avg" | "sum";

type SourceItem = {
  date: string;
  value: number;
};

function dayKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/** Collapse raw samples to one value per calendar day, ascending by day. */
function dailyAggregate(items: SourceItem[], mode: AggregateMode): TrendPoint[] {
  const byDay = new Map<string, number[]>();
  for (const item of items) {
    if (!Number.isFinite(item.value)) continue;
    const bucket = byDay.get(item.date);
    if (bucket) bucket.push(item.value);
    else byDay.set(item.date, [item.value]);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, value: reduceValues(values, mode) }));
}

function reduceValues(values: number[], mode: AggregateMode): number {
  if (mode === "sum") return values.reduce((total, value) => total + value, 0);
  if (mode === "avg") return values.reduce((total, value) => total + value, 0) / values.length;
  return values[values.length - 1];
}

/** Compare the latest point to the nearest point at or before `days` ago. */
function changeOverDays(points: TrendPoint[], days: number): TrendChange | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  const latestMs = Date.parse(`${latest.date}T00:00:00Z`);
  const targetMs = latestMs - days * 86_400_000;
  // Tolerate a few days of gaps around the target so sparse data still reports.
  const toleranceMs = Math.min(days, 7) * 86_400_000;

  let base: TrendPoint | null = null;
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const pointMs = Date.parse(`${points[i].date}T00:00:00Z`);
    if (pointMs <= targetMs + toleranceMs) {
      base = points[i];
      if (pointMs <= targetMs) break;
    }
  }
  if (!base) return null;

  const abs = latest.value - base.value;
  const pct = base.value !== 0 ? (abs / Math.abs(base.value)) * 100 : null;
  return { abs, pct };
}

function summarize(
  config: { key: string; label: string; unit: string; color: string; goodWhen: "up" | "down" | null },
  points: TrendPoint[],
): TrendStat {
  const values = points.map((point) => point.value);
  const latest = points.at(-1) ?? null;
  return {
    ...config,
    points,
    latest: latest?.value ?? null,
    latestAt: latest?.date ?? null,
    average: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    change7d: changeOverDays(points, 7),
    change30d: changeOverDays(points, 30),
  };
}

export type TrendsInput = {
  weight?: BodyMeasurementsResponse;
  steps?: StepDailySummariesResponse;
  sleep?: SleepSummariesResponse;
  hrv?: HrvSamplesResponse;
  activity?: ActivitySummariesResponse;
  respiratory?: RespiratoryRateSamplesResponse;
};

export function buildTrendStats(input: TrendsInput): TrendStat[] {
  const stats: TrendStat[] = [];

  const weightItems = (input.weight?.items ?? []).filter((item) => item.metricType === "weight");
  const weightUnit = weightItems[0]?.unit ?? "kg";
  stats.push(
    summarize(
      { key: "weight", label: "Weight", unit: weightUnit, color: "var(--hue-weight)", goodWhen: null },
      dailyAggregate(
        weightItems.map((item) => ({ date: dayKey(item.measuredAt), value: item.value })),
        "last",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "steps", label: "Steps", unit: "steps", color: "var(--hue-steps)", goodWhen: "up" },
      dailyAggregate(
        (input.steps?.items ?? []).map((item) => ({ date: item.date, value: item.steps })),
        "last",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "sleep", label: "Sleep", unit: "h", color: "var(--hue-sleep)", goodWhen: "up" },
      dailyAggregate(
        (input.sleep?.items ?? [])
          .filter((item) => typeof item.totalSleepSeconds === "number")
          .map((item) => ({ date: dayKey(item.endAt), value: (item.totalSleepSeconds ?? 0) / 3600 })),
        "last",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "sleep_score", label: "Sleep score", unit: "", color: "var(--hue-score)", goodWhen: "up" },
      dailyAggregate(
        (input.sleep?.items ?? [])
          .filter((item) => typeof item.sleepScore === "number")
          .map((item) => ({ date: dayKey(item.endAt), value: item.sleepScore ?? 0 })),
        "last",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "hrv", label: "HRV", unit: "ms", color: "var(--hue-hrv)", goodWhen: "up" },
      dailyAggregate(
        (input.hrv?.items ?? []).map((item) => ({ date: dayKey(item.measuredAt), value: item.value })),
        "avg",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "resting_hr", label: "Resting HR", unit: "bpm", color: "var(--hue-heart)", goodWhen: "down" },
      dailyAggregate(
        (input.activity?.items ?? [])
          .filter((item) => typeof item.minHeartRateBpm === "number")
          .map((item) => ({ date: item.date, value: item.minHeartRateBpm ?? 0 })),
        "last",
      ),
    ),
  );

  stats.push(
    summarize(
      { key: "respiratory", label: "Respiratory", unit: "rpm", color: "var(--hue-resp)", goodWhen: null },
      dailyAggregate(
        (input.respiratory?.items ?? []).map((item) => ({ date: dayKey(item.measuredAt), value: item.value })),
        "avg",
      ),
    ),
  );

  return stats.filter((stat) => stat.points.length > 0);
}

/** Short human sentence describing the dominant 30d (or 7d) movement. */
export function insightSentence(stat: TrendStat): string {
  const change = stat.change30d ?? stat.change7d;
  const window = stat.change30d ? "30 days" : "7 days";
  if (!change || stat.latest === null) {
    return `${stat.points.length} day${stat.points.length === 1 ? "" : "s"} of data in range.`;
  }
  if (Math.abs(change.abs) < 1e-6) {
    return `Flat over the last ${window}.`;
  }
  const direction = change.abs > 0 ? "up" : "down";
  const magnitude =
    change.pct !== null
      ? `${Math.abs(change.pct).toFixed(change.pct >= 10 ? 0 : 1)}%`
      : `${Math.abs(change.abs).toFixed(1)}${stat.unit ? ` ${stat.unit}` : ""}`;
  const verdict =
    stat.goodWhen && stat.goodWhen === direction
      ? " — trending the right way"
      : stat.goodWhen && stat.goodWhen !== direction
        ? " — worth a look"
        : "";
  return `${direction === "up" ? "Up" : "Down"} ${magnitude} over the last ${window}${verdict}.`;
}
