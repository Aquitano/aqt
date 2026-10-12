export type PeriodId = "all" | "today" | "7d" | "30d" | "month" | "6mo";

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export const periods: ReadonlyArray<{ readonly id: PeriodId; readonly label: string }> = [
  { id: "all", label: "All time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "6mo", label: "6 months" },
];

export const isPeriodId = (value: string): value is PeriodId =>
  periods.some((period) => period.id === value);

export const heatmapWeeks = 52;

const pad = (value: number): string => String(value).padStart(2, "0");

export const ymd = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00`);
  return ymd(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
};

// The end is exclusive. Construct both midnights locally so a DST day can be 23 or 25 hours.
export const dateBounds = (range: DayRange): DayRange => ({
  from: new Date(`${range.from}T00:00:00`).toISOString(),
  to: new Date(`${addDays(range.to, 1)}T00:00:00`).toISOString(),
});

// Ranges are inclusive local YYYY-MM-DD computed against the viewer's clock, so
// "today" matches the day the user is looking at rather than a UTC day.
export const periodRange = (id: PeriodId, now = new Date()): DayRange | null => {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const today = ymd(now);
  switch (id) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: ymd(new Date(year, month, day - 6)), to: today };
    case "30d":
      return { from: ymd(new Date(year, month, day - 29)), to: today };
    case "month":
      return { from: ymd(new Date(year, month, 1)), to: today };
    case "6mo":
      return { from: ymd(new Date(year, month - 6, 1)), to: today };
    case "all":
      return null;
  }
};

export const previousRange = (range: DayRange): DayRange => {
  const from = new Date(`${range.from}T00:00:00`);
  const to = new Date(`${range.to}T00:00:00`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  return {
    from: ymd(new Date(from.getFullYear(), from.getMonth(), from.getDate() - days)),
    to: ymd(new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1)),
  };
};

export const heatmapDays = (now = new Date()): ReadonlyArray<ReadonlyArray<string>> => {
  // Anchor the grid to the Sunday on or after today, so the last column is the
  // current week and rows are stable weekdays.
  const sunday = now.getDate() + ((7 - now.getDay()) % 7);
  const start = sunday - (heatmapWeeks * 7 - 1);
  return Array.from({ length: heatmapWeeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) =>
      ymd(new Date(now.getFullYear(), now.getMonth(), start + week * 7 + weekday)),
    ),
  );
};

export const heatmapRange = (now = new Date()): DayRange => ({
  from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - heatmapWeeks * 7)),
  to: ymd(now),
});
