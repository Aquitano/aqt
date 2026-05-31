import { formatDateTime } from "@/lib/format";
import type { BloodPressureMeasurement } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: BloodPressureMeasurement[];
};

export function BloodPressureTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No blood pressure readings found" />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Systolic</th>
            <th>Diastolic</th>
            <th>Reading</th>
            <th>HR</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{item.systolicMmhg} mmHg</td>
              <td>{item.diastolicMmhg} mmHg</td>
              <td>{item.systolicMmhg}/{item.diastolicMmhg} mmHg</td>
              <td>{item.heartRateBpm != null ? `${item.heartRateBpm} bpm` : "-"}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
