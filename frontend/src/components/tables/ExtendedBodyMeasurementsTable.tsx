import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { ExtendedBodyMeasurement } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

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

const columns: Column<ExtendedBodyMeasurement>[] = [
  { header: "Time", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Metric", cell: (item) => metricLabel(item.metricType) },
  { header: "Value", cell: (item) => formatMeasurement(item.value, item.unit) },
  { header: "Segment", cell: (item) => item.segment ?? "-", muted: true },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function ExtendedBodyMeasurementsTable({ items }: { items: ExtendedBodyMeasurement[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No extended body measurements found"
      rowKey={(item) => item.id}
    />
  );
}
