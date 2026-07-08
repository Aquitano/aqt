import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { BodyMeasurement } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<BodyMeasurement>[] = [
  { header: "Measured", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Metric", cell: (item) => item.metricType },
  { header: "Value", cell: (item) => formatMeasurement(item.value, item.unit) },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function BodyMeasurementsTable({ items }: { items: BodyMeasurement[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No body measurements found."
      rowKey={(item) => item.id}
    />
  );
}
