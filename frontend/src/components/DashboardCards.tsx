import { formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type { DashboardSummaryResponse, DashboardTrendsResponse } from "@/lib/types";
import styles from "./DashboardCards.module.css";

type DashboardCardsProps = {
  summary?: DashboardSummaryResponse;
  trends?: DashboardTrendsResponse;
};

const StepsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 16v-2.4C4 11.34 6.34 9 8.6 9h.85c.47 0 .85.38.85.85v1.15" />
    <path d="M18 20v-2.4c0-2.26-2.34-4.6-4.6-4.6h-.85c-.47 0-.85.38-.85.85v1.15" />
    <circle cx="10" cy="5" r="2" />
    <circle cx="17" cy="10" r="2" />
  </svg>
);

const WeightIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="5" r="3" />
    <path d="M6.5 8a2 2 0 0 0-1.9 1.38L2 17h20l-2.6-7.62A2 2 0 0 0 17.5 8h-11z" />
    <path d="M2 17h20v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2z" />
  </svg>
);

const HeartIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
  </svg>
);

const SleepIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </svg>
);

function TrendBadge({ percentChange }: { percentChange?: number | null }) {
  if (percentChange === undefined || percentChange === null) return null;
  const isPositive = percentChange > 0;
  const isNeutral = percentChange === 0;
  const sign = isNeutral ? "" : isPositive ? "+" : "";
  const arrow = isNeutral ? "→" : isPositive ? "↑" : "↓";
  return (
    <span
      className={styles.trend}
      data-direction={isNeutral ? "neutral" : isPositive ? "up" : "down"}
      title={`${sign}${percentChange.toFixed(1)}% vs previous${percentChange === 0 ? " period" : ""}`}
    >
      {arrow} {sign}{Math.abs(percentChange).toFixed(1)}%
    </span>
  );
}

export function DashboardCards({ summary, trends }: DashboardCardsProps) {
  const cards = [
    {
      kind: "steps" as const,
      label: "Steps",
      value: formatNumber(summary?.steps.steps),
      detail: `${formatNumber(summary?.steps.sampleCount)} samples`,
      trend: trends?.steps?.percentChange,
      icon: <StepsIcon />,
    },
    {
      kind: "weight" as const,
      label: "Latest weight",
      value: formatMeasurement(summary?.latestWeight?.value, summary?.latestWeight?.unit),
      detail: summary?.latestWeight?.measuredAt ?? "No data",
      trend: trends?.weight?.percentChange,
      icon: <WeightIcon />,
    },
    {
      kind: "heart" as const,
      label: "Heart rate",
      value: formatMeasurement(summary?.latestHeartRate?.value, summary?.latestHeartRate?.unit),
      detail: summary?.latestHeartRate?.context ?? "No data",
      trend: trends?.heartRate?.percentChange,
      icon: <HeartIcon />,
    },
    {
      kind: "sleep" as const,
      label: "Last sleep",
      value: formatDuration(summary?.lastSleepSession?.durationSeconds),
      detail: summary?.lastSleepSession?.startAt ?? "No data",
      trend: trends?.sleep?.percentChange,
      icon: <SleepIcon />,
    },
  ];

  return (
    <section className={styles.cards} aria-label="Dashboard summary">
      {cards.map((card) => (
        <article className={styles.card} key={card.label} data-kind={card.kind}>
          <div className={styles.icon}>{card.icon}</div>
          <div className={styles.body}>
            <span className={styles.label}>{card.label}</span>
            <span className={styles.value}>{card.value}</span>
            <span className={styles.detail}>
              {card.detail}
              <TrendBadge percentChange={card.trend} />
            </span>
          </div>
        </article>
      ))}
    </section>
  );
}
