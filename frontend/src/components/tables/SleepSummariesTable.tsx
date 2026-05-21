import { formatDateTime, formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type { SleepSummary } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: SleepSummary[];
};

export function SleepSummariesTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No sleep summaries found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Start</th>
            <th>Sleep</th>
            <th>Score</th>
            <th>Efficiency</th>
            <th>Wakeups</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.startAt)}</td>
              <td>{formatDuration(item.totalSleepSeconds)}</td>
              <td>{formatNumber(item.sleepScore)}</td>
              <td>{formatMeasurement(item.sleepEfficiencyPercent, "%")}</td>
              <td>{formatNumber(item.wakeupCount)}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
