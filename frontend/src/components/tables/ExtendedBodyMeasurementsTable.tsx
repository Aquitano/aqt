import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { ExtendedBodyMeasurement } from "@/lib/types";
import { EmptyState, sourceLabel } from "./shared";
import styles from "./tables.module.css";

const METRIC_LABELS: Record<string, string> = {
  fat_mass: "Fat Mass",
  fat_free_mass: "Fat-Free Mass",
  bone_mass: "Bone Mass",
  intracellular_water: "Intracellular Water",
  extracellular_water: "Extracellular Water",
  basal_metabolic_rate: "BMR",
  segmental_fat_mass: "Segmental Fat",
  segmental_muscle_mass: "Segmental Muscle",
  segmental_fat_free_mass: "Segmental Fat-Free",
};

function metricLabel(metricType: string): string {
  return METRIC_LABELS[metricType] ?? metricType;
}

function segmentLabel(segment?: string | null): string {
  return segment ?? "-";
}

type Props = {
  items: ExtendedBodyMeasurement[];
};

export function ExtendedBodyMeasurementsTable({ items }: Props) {
  if (items.length === 0) return <EmptyState label="No extended body measurements found" />;

  return (
    <div className={styles.wrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Metric</th>
            <th>Value</th>
            <th>Segment</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{formatDateTime(item.measuredAt)}</td>
              <td>{metricLabel(item.metricType)}</td>
              <td>{formatMeasurement(item.value, item.unit)}</td>
              <td className={styles.muted}>{segmentLabel(item.segment)}</td>
              <td className={styles.muted}>{sourceLabel(item.source)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
