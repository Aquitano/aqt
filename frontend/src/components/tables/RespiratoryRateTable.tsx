import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { RespiratoryRateSample } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: RespiratoryRateSample[];
};

export function RespiratoryRateTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No respiratory-rate samples found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Measured</th>
            <th>Rate</th>
            <th>Context</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{formatMeasurement(item.breathsPerMinute, "br/min")}</td>
              <td className={styles.muted}>{item.context}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
