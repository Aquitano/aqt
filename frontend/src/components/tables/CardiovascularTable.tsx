import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { CardiovascularMeasurement } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const METRIC_LABELS: Record<string, string> = {
  pulse_wave_velocity: "Pulse Wave Velocity",
  vascular_age: "Vascular Age",
  standing_heart_rate: "Standing Heart Rate",
};

function metricLabel(metricType: string): string {
  return METRIC_LABELS[metricType] ?? metricType;
}

const columns: Column<CardiovascularMeasurement>[] = [
  { header: "Time", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Metric", cell: (item) => metricLabel(item.metricType) },
  { header: "Value", cell: (item) => formatMeasurement(item.value, item.unit) },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function CardiovascularTable({ items }: { items: CardiovascularMeasurement[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No cardiovascular measurements found"
      rowKey={(item) => item.id}
    />
  );
}
