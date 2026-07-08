import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { HrvSample } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<HrvSample>[] = [
  { header: "Measured", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Metric", cell: (item) => item.metricType.toUpperCase() },
  { header: "Value", cell: (item) => formatMeasurement(item.value, item.unit) },
  { header: "Context", cell: (item) => item.context, muted: true },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function HrvTable({ items }: { items: HrvSample[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No HRV samples found."
      rowKey={(item) => item.id}
    />
  );
}
