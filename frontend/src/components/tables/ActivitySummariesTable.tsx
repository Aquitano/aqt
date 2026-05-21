import { formatMeasurement, formatNumber } from "@/lib/format";
import type { ActivitySummary } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

type Props = {
  items: ActivitySummary[];
};

export function ActivitySummariesTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No activity summaries found." />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Distance</th>
            <th>Active energy</th>
            <th>Active min</th>
            <th>Avg HR</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.date}</td>
              <td>{formatMeasurement(distanceKm(item.distanceMeters), "km")}</td>
              <td>{formatMeasurement(item.activeEnergyKcal, "kcal")}</td>
              <td>{formatNumber(item.activeMinutes)}</td>
              <td>{item.averageHeartRateBpm ? `${Math.round(item.averageHeartRateBpm)} bpm` : "n/a"}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function distanceKm(value?: number | null): number | null {
  return typeof value === "number" ? value / 1000 : null;
}
