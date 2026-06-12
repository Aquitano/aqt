import { formatDateTime } from "@/lib/format";
import type { HeartRateSample } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: HeartRateSample[];
};

export function HeartRateTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No heart-rate samples found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Measured</th>
            <th>BPM</th>
            <th>Context</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{item.value}</td>
              <td className={styles.muted}>{item.context}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
