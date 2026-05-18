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
  BodyMeasurement,
  BodyMeasurementsResponse,
  HealthDayBucket,
  HealthDayResponse,
  HeartRateSamplesResponse,
  SleepNightsResponse,
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
  bodyMeasurements?: BodyMeasurementsResponse;
  dailySteps?: StepDailySummariesResponse;
  healthDay?: HealthDayResponse;
  latestHeartRate?: HeartRateSamplesResponse;
  latestSleep?: SleepNightsResponse;
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
  bodyMeasurements,
  dailySteps,
  healthDay,
  latestHeartRate,
  latestSleep,
  fromDate,
  toDate,
  timezone,
}: HealthDataVisualizationsProps) {
  const [modalChart, setModalChart] = useState<ModalChart | null>(null);
  const bodyChart = useMemo(() => buildBodyChart(bodyMeasurements?.items ?? []), [bodyMeasurements]);
  const weightChart = useMemo(() => buildWeightChart(bodyMeasurements?.items ?? []), [bodyMeasurements]);
  const stepsChart = useMemo(() => buildStepsChart(dailySteps?.items ?? []), [dailySteps]);
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
