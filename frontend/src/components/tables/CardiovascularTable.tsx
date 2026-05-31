import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { CardiovascularMeasurement } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

const METRIC_LABELS: Record<string, string> = {
  pulse_wave_velocity: "Pulse Wave Velocity",
  vascular_age: "Vascular Age",
  standing_heart_rate: "Standing Heart Rate",
};

function metricLabel(metricType: string): string {
  return METRIC_LABELS[metricType] ?? metricType;
}

type Props = {
  items: CardiovascularMeasurement[];
};

export function CardiovascularTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No cardiovascular measurements found" />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Metric</th>
            <th>Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{metricLabel(item.metricType)}</td>
              <td>{formatMeasurement(item.value, item.unit)}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
