import type { CSSProperties } from "react";
import { Bars } from "@/components/charts/Bars";
import { SleepTimeline } from "@/components/charts/SleepTimeline";
import { Sparkline } from "@/components/charts/Sparkline";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type { HealthDayBucket, HealthDayResponse } from "@/lib/types";
import styles from "./DayOverview.module.css";

type DayOverviewProps = {
  day?: HealthDayResponse;
  weightDelta7d?: number | null;
  weightDelta7dUnit?: string | null;
};

export function DayOverview({ day, weightDelta7d, weightDelta7dUnit }: DayOverviewProps) {
  const emptyBuckets: HealthDayBucket[] = [];
  const weightBuckets =
    day?.weight?.points.map((point) => ({
      startAt: point.measuredAt,
      endAt: point.measuredAt,
      value: point.value,
      count: 1,
    })) ?? emptyBuckets;

  return (
    <section className={styles.overview} aria-label="One-day overview">
      <article className={styles.card} data-kind="weight" data-reveal style={revealIndex(1)}>
        <div className={styles.head}>
          <span className={styles.label}>Weight</span>
          <span className={styles.meta}>{formatSevenDayDelta(weightDelta7d, weightDelta7dUnit)}</span>
        </div>
        <AnimatedNumber
          className={styles.value}
          value={formatMeasurement(day?.weight?.latest?.value, day?.weight?.latest?.unit)}
        />
        <div className={styles.chart}>
          <Sparkline buckets={weightBuckets} />
        </div>
      </article>

      <article className={styles.card} data-kind="steps" data-reveal style={revealIndex(2)}>
        <div className={styles.head}>
          <span className={styles.label}>Steps</span>
          <span className={styles.meta}>{formatNumber(day?.steps?.sampleCount)} samples</span>
        </div>
        <AnimatedNumber className={styles.value} value={formatNumber(day?.steps?.total)} />
        <div className={styles.chart}>
          <Bars buckets={day?.steps?.buckets ?? []} />
        </div>
      </article>

      <article className={styles.card} data-kind="heart" data-reveal style={revealIndex(3)}>
        <div className={styles.head}>
          <span className={styles.label}>Heart rate</span>
          <span className={styles.meta}>
            {day?.heartRate?.minBpm && day.heartRate.maxBpm
              ? `${day.heartRate.minBpm}-${day.heartRate.maxBpm}`
              : "n/a"}
          </span>
        </div>
        <AnimatedNumber
          className={styles.value}
          value={day?.heartRate?.latest ? `${day.heartRate.latest.value} ${day.heartRate.latest.unit}` : "n/a"}
        />
        <div className={styles.subvalue}>
          avg {day?.heartRate?.avgBpm ? `${Math.round(day.heartRate.avgBpm)} bpm` : "n/a"}
        </div>
        <div className={styles.chart}>
          <Sparkline buckets={day?.heartRate?.buckets ?? []} />
        </div>
      </article>

      <article className={styles.card} data-kind="sleep" data-reveal style={revealIndex(4)}>
        <div className={styles.head}>
          <span className={styles.label}>Sleep</span>
          <span className={styles.meta}>{day?.sleep?.sessions.length ?? 0} sessions</span>
        </div>
        <AnimatedNumber className={styles.value} value={formatDuration(day?.sleep?.totalDurationSeconds)} />
        <div className={styles.stageTotals}>
          {day?.sleep?.stageTotals.length
            ? day.sleep.stageTotals.map((stage) => (
                <span key={stage.stage}>
                  {stage.stage} {formatDuration(stage.durationSeconds)}
                </span>
              ))
            : <span>n/a</span>}
        </div>
        <div className={styles.chart}>
          <SleepTimeline from={day?.from} to={day?.to} timeline={day?.sleep?.timeline ?? []} />
        </div>
      </article>
    </section>
  );
}

function revealIndex(index: number): CSSProperties {
  return { "--reveal-i": index } as CSSProperties;
}

function formatDelta(value?: number | null, unit?: string | null): string {
  if (value === undefined || value === null) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)} ${unit ?? ""}`.trim();
}

function formatSevenDayDelta(value?: number | null, unit?: string | null): string {
  return `7d ${formatDelta(value, unit)}`;
}
