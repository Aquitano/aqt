export function formatDateTime(value?: string | number | null): string {
  if (value === undefined || value === null || value === "") return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "number" ? "n/a" : String(value);

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

export function formatChartValue(value: number, unit?: string | null): string {
  const formatted = new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}

export function formatAxisDate(value: string): string {
  const date = parseDay(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

export function formatFullDate(value: string): string {
  const date = parseDay(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}

// Date-only strings pin to local midnight; bare `new Date("YYYY-MM-DD")` would
// parse as UTC and shift the rendered day in negative-offset timezones.
function parseDay(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
}
