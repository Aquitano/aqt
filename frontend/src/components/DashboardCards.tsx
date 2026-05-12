import { formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type { DashboardSummaryResponse } from "@/lib/types";

type DashboardCardsProps = {
  summary?: DashboardSummaryResponse;
};

export function DashboardCards({ summary }: DashboardCardsProps) {
  const cards = [
    {
      label: "Steps",
      value: formatNumber(summary?.steps.steps),
      detail: `${formatNumber(summary?.steps.sampleCount)} samples`,
    },
    {
      label: "Latest weight",
      value: formatMeasurement(summary?.latestWeight?.value, summary?.latestWeight?.unit),
      detail: summary?.latestWeight?.measuredAt ?? "No weight data",
    },
    {
      label: "Latest heart rate",
      value: summary?.latestHeartRate ? `${summary.latestHeartRate.bpm} bpm` : "n/a",
      detail: summary?.latestHeartRate?.context ?? "No heart-rate data",
    },
    {
      label: "Last sleep",
      value: formatDuration(summary?.lastSleepSession?.durationSeconds),
      detail: summary?.lastSleepSession?.startAt ?? "No sleep data",
    },
  ];

  return (
    <section className="cards" aria-label="Dashboard summary">
      {cards.map((card) => (
        <article className="summary-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.detail}</small>
        </article>
      ))}
    </section>
  );
}
