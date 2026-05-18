export function formatDateTime(value?: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatNumber(value?: number | null): string {
  if (value === undefined || value === null) return "n/a";
  return new Intl.NumberFormat("en").format(value);
}

export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null) return "n/a";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function formatMeasurement(value?: number | null, unit?: string | null): string {
  if (value === undefined || value === null) return "n/a";
  return `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)} ${unit ?? ""}`.trim();
}
