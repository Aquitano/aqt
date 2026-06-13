import type { CSSProperties } from "react";
import { formatDateTime, formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type {
  ActivitySummaryLatestResponse,
  BloodPressureLatestResponse,
  HrvSamplesResponse,
  RespiratoryRateSamplesResponse,
  SleepSummaryLatestResponse,
} from "@/lib/types";
import styles from "./MetricHighlights.module.css";

type MetricHighlightsProps = {
  latestActivity?: ActivitySummaryLatestResponse;
  latestSleepSummary?: SleepSummaryLatestResponse;
  latestRespiratoryRate?: RespiratoryRateSamplesResponse;
  latestHrv?: HrvSamplesResponse;
  latestBloodPressure?: BloodPressureLatestResponse;
};
export function MetricHighlights({
  latestActivity,
  latestSleepSummary,
  latestRespiratoryRate,
  latestHrv,
  latestBloodPressure,
}: MetricHighlightsProps) {
  const activity = latestActivity?.items[0];
  const sleep = latestSleepSummary?.items[0];
  const respiratoryRate = latestRespiratoryRate?.items[0];
  const hrv = latestHrv?.items[0];
  const bp = latestBloodPressure?.items[0];

  const cards = [
    {
      kind: "blood-pressure",
      label: "Blood pressure",
      value: bp ? `${bp.systolicMmhg}/${bp.diastolicMmhg} mmHg` : "n/a",
      detail: bp
        ? `${bp.heartRateBpm ? bp.heartRateBpm + " bpm · " : ""}${formatDateTime(bp.measuredAt)}`
        : "No blood pressure reading",
    },
    {
      kind: "activity",
      label: "Latest activity",
      value: activity?.distanceMeters
        ? formatMeasurement(activity.distanceMeters / 1000, "km")
        : formatMeasurement(activity?.activeEnergyKcal, "kcal"),
      detail: activity
        ? `${activity.date} - ${formatMeasurement(activity.activeEnergyKcal, "active kcal")} - ${formatNumber(activity.activeMinutes)} active min`
        : "No activity summary",
    },
    {
      kind: "sleep",
      label: "Sleep score",
      value: sleep?.sleepScore !== undefined && sleep.sleepScore !== null ? `${sleep.sleepScore}/100` : "n/a",
      detail: sleep
        ? `${formatDuration(sleep.totalSleepSeconds)} asleep - ${formatMeasurement(sleep.sleepEfficiencyPercent, "%")} efficiency`
        : "No sleep summary",
    },
    {
      kind: "respiratory",
      label: "Respiratory rate",
      value: respiratoryRate ? formatMeasurement(respiratoryRate.value, respiratoryRate.unit) : "n/a",
      detail: respiratoryRate
        ? `${respiratoryRate.context} - ${formatDateTime(respiratoryRate.measuredAt)}`
        : "No respiratory-rate sample",
    },
    {
      kind: "hrv",
      label: "HRV",
      value: hrv ? formatMeasurement(hrv.value, hrv.unit) : "n/a",
      detail: hrv
        ? `${hrv.metricType.toUpperCase()} - ${hrv.context} - ${formatDateTime(hrv.measuredAt)}`
        : "No HRV sample",
    },
  ];

  return (
    <section className={styles.cards} aria-label="Latest expanded metrics">
      {cards.map((card, index) => (
        <article
          className={styles.card}
          data-kind={card.kind}
          key={card.kind}
          data-reveal
          style={{ "--reveal-i": index } as CSSProperties}
        >
          <span className={styles.label}>{card.label}</span>
          <span className={styles.value}>{card.value}</span>
          <span className={styles.detail}>{card.detail}</span>
        </article>
      ))}
    </section>
  );
}
