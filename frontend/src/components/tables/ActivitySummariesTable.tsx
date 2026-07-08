import { formatMeasurement, formatNumber } from "@/lib/format";
import type { ActivitySummary } from "@/lib/types";
import { DataTable, type Column } from "./DataTable";
import { sourceLabel } from "./shared";

function distanceKm(value?: number | null): number | null {
  return typeof value === "number" ? value / 1000 : null;
}

const columns: Column<ActivitySummary>[] = [
  { header: "Date", cell: (item) => item.date },
  { header: "Distance", cell: (item) => formatMeasurement(distanceKm(item.distanceMeters), "km") },
  { header: "Active energy", cell: (item) => formatMeasurement(item.activeEnergyKcal, "kcal") },
  { header: "Active min", cell: (item) => formatNumber(item.activeMinutes) },
  {
    header: "Avg HR",
    cell: (item) => (item.averageHeartRateBpm ? `${Math.round(item.averageHeartRateBpm)} bpm` : "n/a"),
  },
  { header: "Source", cell: (item) => sourceLabel(item.source), muted: true },
];

export function ActivitySummariesTable({ items }: { items: ActivitySummary[] }) {
  return (
    <DataTable
      items={items}
      columns={columns}
      emptyLabel="No activity summaries found."
      rowKey={(item) => item.id}
    />
  );
}
