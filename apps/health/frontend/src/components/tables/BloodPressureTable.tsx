import { formatDateTime } from "@/lib/format";
import type { BloodPressureMeasurement } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<BloodPressureMeasurement>[] = [
  { header: "Time", cell: (item) => formatDateTime(item.measuredAt) },
  { header: "Systolic", cell: (item) => `${item.systolicMmhg} mmHg` },
  { header: "Diastolic", cell: (item) => `${item.diastolicMmhg} mmHg` },
  { header: "Reading", cell: (item) => `${item.systolicMmhg}/${item.diastolicMmhg} mmHg` },
  { header: "HR", cell: (item) => (item.heartRateBpm != null ? `${item.heartRateBpm} bpm` : "-") },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function BloodPressureTable({ items }: { items: BloodPressureMeasurement[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No blood pressure readings found"
      rowKey={(item) => item.id}
    />
  );
}
