import { formatDateTime, formatDuration } from "@/lib/format";
import type { SleepSession } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: SleepSession[];
};

export function SleepSessionsTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No sleep sessions found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Start</th>
            <th>End</th>
            <th>Duration</th>
            <th>Stages</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.startAt)}</td>
              <td>{formatDateTime(item.endAt)}</td>
              <td>{formatDuration(item.durationSeconds)}</td>
              <td className={styles.muted}>
                {item.stages.map((stage) => stage.stage).join(", ") || "n/a"}
              </td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
