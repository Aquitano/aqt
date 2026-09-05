import { formatDateTime, formatMeasurement } from "@/lib/format";
import type { RespiratoryRateSample } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<RespiratoryRateSample>[] = [
  { header: "Measured", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Rate", cell: (item) => formatMeasurement(item.value, item.unit) },
  { header: "Context", cell: (item) => item.context, muted: true },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function RespiratoryRateTable({ items }: { items: RespiratoryRateSample[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No respiratory-rate samples found."
      rowKey={(item) => item.id}
    />
  );
}
