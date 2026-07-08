import { formatNumber } from "@/lib/format";
import type { StepDailySummary } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

const columns: Column<StepDailySummary>[] = [
  { header: "Date", cell: (item) => item.date },
  { header: "Steps", cell: (item) => formatNumber(item.steps) },
  { header: "Samples", cell: (item) => formatNumber(item.sampleCount), muted: true },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function DailyStepsTable({ items }: { items: StepDailySummary[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No daily step summaries found."
      rowKey={(item) => `${item.date}-${item.source?.providerInstanceId ?? "all"}`}
    />
  );
}
