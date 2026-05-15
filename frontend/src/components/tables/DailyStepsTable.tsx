import { formatNumber } from "@/lib/format";
import type { StepDailySummary } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: StepDailySummary[];
};

export function DailyStepsTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No daily step summaries found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Steps</th>
            <th>Samples</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.date}-${item.source?.providerInstanceId ?? "all"}`}>
              <td>{item.date}</td>
              <td>{formatNumber(item.steps)}</td>
              <td className={styles.muted}>{formatNumber(item.sampleCount)}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
