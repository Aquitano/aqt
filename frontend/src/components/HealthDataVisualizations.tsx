"use client";

import { useMemo, useState } from "react";
import { ExpandedChartModal, type ChartSummary } from "./ExpandedChartModal";
import {
  HealthChartDatum,
  HealthChartSeries,
  HealthMetricChart,
  type ChartPointDetail,
} from "./charts/HealthMetricChart";
import type {
  ActivitySummariesResponse,
  BodyMeasurement,
  BodyMeasurementsResponse,
  HealthDayBucket,
  HealthDayResponse,
  HeartRateSamplesResponse,
  HrvSamplesResponse,
  RespiratoryRateSamplesResponse,
  SleepNightsResponse,
  SleepSummariesResponse,
  StepDailySummariesResponse,
} from "@/lib/types";
import styles from "./HealthDataVisualizations.module.css";

const bodyMetricConfig: Record<string, { label: string; color: string }> = {
  weight: { label: "Weight", color: "#7fd4c4" },
  body_fat: { label: "Body fat", color: "#f2b36d" },
  muscle: { label: "Muscle", color: "#8fa2ff" },
  water: { label: "Water", color: "#67c7e8" },
  visceral_fat: { label: "Visceral fat", color: "#d46a6a" },
};

const bodyMetricOrder = ["weight", "body_fat", "muscle", "water", "visceral_fat"];

type HealthDataVisualizationsProps = {
  activitySummaries?: ActivitySummariesResponse;
  bodyMeasurements?: BodyMeasurementsResponse;
  dailySteps?: StepDailySummariesResponse;
  healthDay?: HealthDayResponse;
  hrvSamples?: HrvSamplesResponse;
  latestHeartRate?: HeartRateSamplesResponse;
  latestSleep?: SleepNightsResponse;
  respiratoryRates?: RespiratoryRateSamplesResponse;
  sleepSummaries?: SleepSummariesResponse;
  fromDate: string;
  toDate: string;
  timezone: string;
};

type ModalChart = {
  title: string;
  description?: string;
  series: HealthChartSeries[];
  data: HealthChartDatum[];
  defaultVisibleMetricKeys: string[];
  summaries: ChartSummary[];
  details: ChartPointDetail[];
};

export function HealthDataVisualizations({
  activitySummaries,
  bodyMeasurements,
  dailySteps,
  healthDay,
  hrvSamples,
  latestHeartRate,
  latestSleep,
  respiratoryRates,
  sleepSummaries,
  fromDate,
  toDate,
  timezone,
}: HealthDataVisualizationsProps) {
  const [modalChart, setModalChart] = useState<ModalChart | null>(null);
  const bodyChart = useMemo(() => buildBodyChart(bodyMeasurements?.items ?? []), [bodyMeasurements]);
  const weightChart = useMemo(() => buildWeightChart(bodyMeasurements?.items ?? []), [bodyMeasurements]);
  const stepsChart = useMemo(() => buildStepsChart(dailySteps?.items ?? []), [dailySteps]);
  const activityChart = useMemo(() => buildActivityChart(activitySummaries?.items ?? []), [activitySummaries]);
  const heartRateChart = useMemo(
    () => buildBucketChart({
      buckets: healthDay?.heartRate?.buckets ?? [],
      metricKey: "heart_rate",
      label: "Heart rate",
      unit: "bpm",
      color: "#d46a6a",
    }),
    [healthDay],
  );
  const sleepChart = useMemo(() => buildSleepChart(latestSleep), [latestSleep]);
  const sleepSummaryChart = useMemo(() => buildSleepSummaryChart(sleepSummaries?.items ?? []), [sleepSummaries]);
  const respiratoryRateChart = useMemo(
    () => buildRespiratoryRateChart(respiratoryRates?.items ?? []),
    [respiratoryRates],
  );
  const hrvChart = useMemo(() => buildHrvChart(hrvSamples?.items ?? []), [hrvSamples]);
  const dateLabel = `${fromDate} to ${toDate} (${timezone})`;

  return (
    <section className={styles.section} aria-label="Health visualizations">
      <div className={styles.heading}>
        <div>
          <h2>Visual analytics</h2>
          <p>{dateLabel}</p>
        </div>
      </div>

      <div className={styles.primaryGrid}>
        <HealthMetricChart
          key={`body-${bodyChart.defaultVisibleMetricKeys.join("-")}-${bodyChart.data.length}`}
          title="Body composition"
          description="All body measurements available in the selected range."
          series={bodyChart.series}
          data={bodyChart.data}
          defaultVisibleMetricKeys={bodyChart.defaultVisibleMetricKeys}
          height={320}
          onExpand={(visible) =>
            openModal({
              title: "Body composition",
              description: dateLabel,
              chart: bodyChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`weight-${weightChart.data.length}`}
          title="Weight trend"
          description="Weight measurements with latest, range, and movement detail."
          series={weightChart.series}
          data={weightChart.data}
          defaultVisibleMetricKeys={weightChart.defaultVisibleMetricKeys}
          height={320}
          onExpand={(visible) =>
            openModal({
              title: "Weight trend",
              description: dateLabel,
              chart: weightChart,
              visibleMetricKeys: visible,
            })
          }
        />
      </div>

      <div className={styles.secondaryGrid}>
        <HealthMetricChart
          key={`steps-${stepsChart.data.length}`}
          title="Daily steps"
          description="Daily totals from normalized step summaries."
          series={stepsChart.series}
          data={stepsChart.data}
          defaultVisibleMetricKeys={stepsChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Daily steps",
              description: dateLabel,
              chart: stepsChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`activity-${activityChart.data.length}`}
          title="Activity summaries"
          description="Distance, energy, active minutes, and daily heart-rate ranges."
          series={activityChart.series}
          data={activityChart.data}
          defaultVisibleMetricKeys={activityChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Activity summaries",
              description: dateLabel,
              chart: activityChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`heart-${heartRateChart.data.length}`}
          title="Heart-rate detail"
          description={latestHeartRate?.items.length ? "Bucketed day view plus latest sample context." : "Bucketed day view."}
          series={heartRateChart.series}
          data={heartRateChart.data}
          defaultVisibleMetricKeys={heartRateChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Heart-rate detail",
              description: dateLabel,
              chart: heartRateChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`sleep-${sleepChart.data.length}`}
          title="Sleep sessions"
          description="Sleep duration by recorded session."
          series={sleepChart.series}
          data={sleepChart.data}
          defaultVisibleMetricKeys={sleepChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Sleep sessions",
              description: dateLabel,
              chart: sleepChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`sleep-summary-${sleepSummaryChart.data.length}`}
          title="Sleep summaries"
          description="Sleep score, efficiency, and duration totals."
          series={sleepSummaryChart.series}
          data={sleepSummaryChart.data}
          defaultVisibleMetricKeys={sleepSummaryChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Sleep summaries",
              description: dateLabel,
              chart: sleepSummaryChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`respiratory-${respiratoryRateChart.data.length}`}
          title="Respiratory rate"
          description="Breaths per minute across the selected range."
          series={respiratoryRateChart.series}
          data={respiratoryRateChart.data}
          defaultVisibleMetricKeys={respiratoryRateChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "Respiratory rate",
              description: dateLabel,
              chart: respiratoryRateChart,
              visibleMetricKeys: visible,
            })
          }
        />
        <HealthMetricChart
          key={`hrv-${hrvChart.data.length}`}
          title="HRV"
          description="Heart-rate variability samples by metric type."
          series={hrvChart.series}
          data={hrvChart.data}
          defaultVisibleMetricKeys={hrvChart.defaultVisibleMetricKeys}
          height={260}
          onExpand={(visible) =>
            openModal({
              title: "HRV",
              description: dateLabel,
              chart: hrvChart,
              visibleMetricKeys: visible,
            })
          }
        />
      </div>

      {modalChart ? (
        <ExpandedChartModal
          title={modalChart.title}
          description={modalChart.description}
          series={modalChart.series}
          data={modalChart.data}
          defaultVisibleMetricKeys={modalChart.defaultVisibleMetricKeys}
          summaries={modalChart.summaries}
          details={modalChart.details}
          onClose={() => setModalChart(null)}
        />
      ) : null}
    </section>
  );

  function openModal({
    title,
    description,
    chart,
    visibleMetricKeys,
  }: {
    title: string;
    description: string;
    chart: NormalizedChart;
    visibleMetricKeys: string[];
  }) {
    const selectedKeys = visibleMetricKeys.length ? visibleMetricKeys : chart.defaultVisibleMetricKeys;
    setModalChart({
      title,
      description,
      series: chart.series,
      data: chart.data,
      defaultVisibleMetricKeys: selectedKeys,
      summaries: buildSummaries(chart.details, selectedKeys),
      details: chart.details.filter((detail) => selectedKeys.includes(detail.metricKey)),
    });
  }
}

type NormalizedChart = {
  series: HealthChartSeries[];
  data: HealthChartDatum[];
  details: ChartPointDetail[];
  defaultVisibleMetricKeys: string[];
};

function buildBodyChart(items: BodyMeasurement[]): NormalizedChart {
  const supported = items.filter((item) => item.metricType in bodyMetricConfig);
  const presentMetricKeys = bodyMetricOrder.filter((metricKey) =>
    supported.some((item) => item.metricType === metricKey),
  );
  const unitByMetric = new Map<string, string>();
  for (const item of supported) {
    if (!unitByMetric.has(item.metricType)) unitByMetric.set(item.metricType, item.unit);
  }

  return {
    series: presentMetricKeys.map((metricKey) => ({
      key: metricKey,
      label: bodyMetricConfig[metricKey].label,
      color: bodyMetricConfig[metricKey].color,
      unit: unitByMetric.get(metricKey),
    })),
    data: measurementsToData(supported),
    details: measurementsToDetails(supported),
    defaultVisibleMetricKeys: presentMetricKeys,
  };
}

function buildWeightChart(items: BodyMeasurement[]): NormalizedChart {
  const weightItems = items.filter((item) => item.metricType === "weight");
  return {
    series: weightItems.length
      ? [{ key: "weight", label: "Weight", color: bodyMetricConfig.weight.color, unit: weightItems[0]?.unit }]
      : [],
    data: measurementsToData(weightItems),
    details: measurementsToDetails(weightItems),
    defaultVisibleMetricKeys: ["weight"],
  };
}

function buildStepsChart(items: StepDailySummariesResponse["items"]): NormalizedChart {
  const details: ChartPointDetail[] = [...items]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => ({
      id: `steps-${item.date}-${item.source?.providerInstanceId ?? "all"}`,
      at: `${item.date}T12:00:00.000Z`,
      metricKey: "steps",
      label: "Steps",
      value: item.steps,
      unit: "steps",
      source: sourceLabel(item.source),
    }));

  return detailsToChart(details, [{ key: "steps", label: "Steps", color: "#d4a94a", unit: "steps" }], ["steps"]);
}

function buildActivityChart(items: ActivitySummariesResponse["items"]): NormalizedChart {
  const details: ChartPointDetail[] = [];
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)) {
    const at = `${item.date}T12:00:00.000Z`;
    const source = sourceLabel(item.source);
    if (typeof item.distanceMeters === "number") {
      details.push({
        id: `activity-distance-${item.id}`,
        at,
        metricKey: "distance",
        label: "Distance",
        value: item.distanceMeters / 1000,
        unit: "km",
        source,
      });
    }
    if (typeof item.activeEnergyKcal === "number") {
      details.push({
        id: `activity-energy-${item.id}`,
        at,
        metricKey: "active_energy",
        label: "Active energy",
        value: item.activeEnergyKcal,
        unit: "kcal",
        source,
      });
    }
    if (typeof item.activeMinutes === "number") {
      details.push({
        id: `activity-minutes-${item.id}`,
        at,
        metricKey: "active_minutes",
        label: "Active minutes",
        value: item.activeMinutes,
        unit: "min",
        source,
      });
    }
    if (typeof item.averageHeartRateBpm === "number") {
      details.push({
        id: `activity-avg-hr-${item.id}`,
        at,
        metricKey: "average_heart_rate",
        label: "Avg heart rate",
        value: item.averageHeartRateBpm,
        unit: "bpm",
        source,
      });
    }
  }

  return detailsToChart(
    details,
    [
      { key: "distance", label: "Distance", color: "#d4a94a", unit: "km" },
      { key: "active_energy", label: "Active energy", color: "#f2b36d", unit: "kcal" },
      { key: "active_minutes", label: "Active minutes", color: "#7fd4c4", unit: "min" },
      { key: "average_heart_rate", label: "Avg heart rate", color: "#d46a6a", unit: "bpm" },
    ],
    ["distance", "active_minutes"],
  );
}

function buildBucketChart({
  buckets,
  metricKey,
  label,
  unit,
  color,
}: {
  buckets: HealthDayBucket[];
  metricKey: string;
  label: string;
  unit: string;
  color: string;
}): NormalizedChart {
  const details = buckets
    .filter((bucket) => typeof bucket.value === "number")
    .map((bucket) => ({
      id: `${metricKey}-${bucket.startAt}`,
      at: bucket.startAt,
      metricKey,
      label,
      value: bucket.value ?? 0,
      unit,
      source: bucket.count ? `${bucket.count} samples` : undefined,
    }));

  return detailsToChart(details, [{ key: metricKey, label, color, unit }], [metricKey]);
}

function buildSleepChart(latestSleep?: SleepNightsResponse): NormalizedChart {
  const details: ChartPointDetail[] = (latestSleep?.items ?? [])
    .map((night) => night.session)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .map((session) => ({
      id: `sleep-${session.id}`,
      at: session.startAt,
      metricKey: "sleep",
      label: "Sleep",
      value: session.durationSeconds / 3600,
      unit: "h",
      source: sourceLabel(session.source),
    }));

  return detailsToChart(details, [{ key: "sleep", label: "Sleep", color: "#8fa2ff", unit: "h" }], ["sleep"]);
}

function buildSleepSummaryChart(items: SleepSummariesResponse["items"]): NormalizedChart {
  const details: ChartPointDetail[] = [];
  for (const item of [...items].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id - b.id)) {
    const source = sourceLabel(item.source);
    if (typeof item.sleepScore === "number") {
      details.push({
        id: `sleep-score-${item.id}`,
        at: item.startAt,
        metricKey: "sleep_score",
        label: "Sleep score",
        value: item.sleepScore,
        unit: "score",
        source,
      });
    }
    if (typeof item.sleepEfficiencyPercent === "number") {
      details.push({
        id: `sleep-efficiency-${item.id}`,
        at: item.startAt,
        metricKey: "sleep_efficiency",
        label: "Efficiency",
        value: item.sleepEfficiencyPercent,
        unit: "%",
        source,
      });
    }
    if (typeof item.totalSleepSeconds === "number") {
      details.push({
        id: `sleep-total-${item.id}`,
        at: item.startAt,
        metricKey: "sleep_hours",
        label: "Sleep",
        value: item.totalSleepSeconds / 3600,
        unit: "h",
        source,
      });
    }
    if (typeof item.wakeupCount === "number") {
      details.push({
        id: `sleep-wakeups-${item.id}`,
        at: item.startAt,
        metricKey: "wakeups",
        label: "Wakeups",
        value: item.wakeupCount,
        unit: "count",
        source,
      });
    }
  }

  return detailsToChart(
    details,
    [
      { key: "sleep_score", label: "Sleep score", color: "#8fa2ff", unit: "score" },
      { key: "sleep_efficiency", label: "Efficiency", color: "#67c7e8", unit: "%" },
      { key: "sleep_hours", label: "Sleep", color: "#7fd4c4", unit: "h" },
      { key: "wakeups", label: "Wakeups", color: "#f2b36d", unit: "count" },
    ],
    ["sleep_score", "sleep_efficiency"],
  );
}

function buildRespiratoryRateChart(items: RespiratoryRateSamplesResponse["items"]): NormalizedChart {
  const details = [...items]
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.id - b.id)
    .map((item) => ({
      id: `respiratory-${item.id}`,
      at: item.measuredAt,
      metricKey: "respiratory_rate",
      label: "Respiratory rate",
      value: item.breathsPerMinute,
      unit: "br/min",
      source: sourceLabel(item.source),
    }));

  return detailsToChart(
    details,
    [{ key: "respiratory_rate", label: "Respiratory rate", color: "#67c7e8", unit: "br/min" }],
    ["respiratory_rate"],
  );
}

function buildHrvChart(items: HrvSamplesResponse["items"]): NormalizedChart {
  const presentMetricKeys = Array.from(new Set(items.map((item) => item.metricType))).sort();
  const details = [...items]
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.id - b.id)
    .map((item) => ({
      id: `hrv-${item.id}`,
      at: item.measuredAt,
      metricKey: item.metricType,
      label: item.metricType.toUpperCase(),
      value: item.value,
      unit: item.unit,
      source: sourceLabel(item.source),
    }));

  return detailsToChart(
    details,
    presentMetricKeys.map((metricKey, index) => ({
      key: metricKey,
      label: metricKey.toUpperCase(),
      color: ["#9dcf7a", "#7fd4c4", "#8fa2ff"][index % 3],
      unit: items.find((item) => item.metricType === metricKey)?.unit,
    })),
    presentMetricKeys.length ? [presentMetricKeys[0]] : [],
  );
}

function measurementsToData(items: BodyMeasurement[]): HealthChartDatum[] {
  return detailsToData(measurementsToDetails(items));
}

function measurementsToDetails(items: BodyMeasurement[]): ChartPointDetail[] {
  return [...items]
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.id - b.id)
    .map((item) => ({
      id: String(item.id),
      at: item.measuredAt,
      metricKey: item.metricType,
      label: bodyMetricConfig[item.metricType]?.label ?? item.metricType,
      value: item.value,
      unit: item.unit,
      source: sourceLabel(item.source),
    }));
}

function detailsToChart(
  details: ChartPointDetail[],
  series: HealthChartSeries[],
  defaultVisibleMetricKeys: string[],
): NormalizedChart {
  return {
    series: details.length ? series : [],
    data: detailsToData(details),
    details,
    defaultVisibleMetricKeys,
  };
}

function detailsToData(details: ChartPointDetail[]): HealthChartDatum[] {
  const byTimestamp = new Map<string, HealthChartDatum>();
  for (const detail of details) {
    const timestamp = Date.parse(detail.at);
    const id = Number.isNaN(timestamp) ? detail.at : String(timestamp);
    const existing: HealthChartDatum = byTimestamp.get(id) ?? {
      id,
      timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
      label: formatAxisDate(detail.at),
      details: {},
    };
    existing[detail.metricKey] = detail.value;
    existing.details[detail.metricKey] = detail;
    byTimestamp.set(id, existing);
  }

  return Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function buildSummaries(details: ChartPointDetail[], visibleMetricKeys: string[]): ChartSummary[] {
  const metricKey = visibleMetricKeys.find((key) => details.some((detail) => detail.metricKey === key));
  if (!metricKey) return [];
  const metricDetails = details.filter((detail) => detail.metricKey === metricKey).sort((a, b) => a.at.localeCompare(b.at));
  const values = metricDetails.map((detail) => detail.value);
  const latest = metricDetails[metricDetails.length - 1];
  const oldest = metricDetails[0];
  const unit = latest?.unit;
  const average = values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
  const delta = latest && oldest ? latest.value - oldest.value : undefined;

  return [
    { label: "Metric", value: latest?.label ?? metricKey },
    { label: "Latest", value: latest ? formatValue(latest.value, unit) : "n/a" },
    { label: "Min", value: values.length ? formatValue(Math.min(...values), unit) : "n/a" },
    { label: "Max", value: values.length ? formatValue(Math.max(...values), unit) : "n/a" },
    { label: "Average", value: average !== undefined ? formatValue(average, unit) : "n/a" },
    { label: "Delta", value: delta !== undefined ? formatSignedValue(delta, unit) : "n/a" },
  ];
}

function formatAxisDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function formatValue(value: number, unit?: string): string {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatSignedValue(value: number, unit?: string): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatValue(value, unit)}`;
}

function sourceLabel(source?: { provider: string; providerInstanceId: string } | null): string | undefined {
  if (!source) return undefined;
  return `${source.provider} / ${source.providerInstanceId}`;
}
