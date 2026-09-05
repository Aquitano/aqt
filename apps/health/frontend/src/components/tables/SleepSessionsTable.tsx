import { formatDateTime, formatDuration } from "@/lib/format";
import type { SleepSession } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<SleepSession>[] = [
  { header: "Start", cell: (item) => formatDateTime(item.startAt) },
  { header: "End", cell: (item) => formatDateTime(item.endAt) },
  { header: "Duration", cell: (item) => formatDuration(item.durationSeconds) },
  {
    header: "Stages",
    cell: (item) => item.stages.map((stage) => stage.stage).join(", ") || "n/a",
    muted: true,
  },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function SleepSessionsTable({ items }: { items: SleepSession[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No sleep sessions found."
      rowKey={(item) => item.id}
    />
  );
}
