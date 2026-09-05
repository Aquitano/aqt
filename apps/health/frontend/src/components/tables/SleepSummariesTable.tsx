import { formatDateTime, formatDuration, formatMeasurement, formatNumber } from "@/lib/format";
import type { SleepSummary } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<SleepSummary>[] = [
  { header: "Start", cell: (item) => formatDateTime(item.startAt) },
  { header: "Sleep", cell: (item) => formatDuration(item.totalSleepSeconds) },
  { header: "Score", cell: (item) => formatNumber(item.sleepScore) },
  { header: "Efficiency", cell: (item) => formatMeasurement(item.sleepEfficiencyPercent, "%") },
  { header: "Wakeups", cell: (item) => formatNumber(item.wakeupCount) },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function SleepSummariesTable({ items }: { items: SleepSummary[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No sleep summaries found."
      rowKey={(item) => item.id}
    />
  );
}
