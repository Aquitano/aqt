import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { BodyMeasurement } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: BodyMeasurement[];
};

export function BodyMeasurementsTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No body measurements found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Measured</th>
            <th>Metric</th>
            <th>Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{item.metricType}</td>
              <td>{formatMeasurement(item.value, item.unit)}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
