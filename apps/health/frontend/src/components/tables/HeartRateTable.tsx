import { formatDateTime } from "@/lib/format";
import type { HeartRateSample } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<HeartRateSample>[] = [
  { header: "Measured", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "BPM", cell: (item) => item.value },
  { header: "Context", cell: (item) => item.context, muted: true },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function HeartRateTable({ items }: { items: HeartRateSample[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No heart-rate samples found."
      rowKey={(item) => item.id}
    />
  );
}
