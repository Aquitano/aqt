export type DateRange = {
  fromDate: string;
  toDate: string;
  timezone: string;
  warning?: string;
};

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export function defaultDateRange(now = new Date(), timezone = "UTC"): DateRange {
  const toDate = dateInputValueInTimeZone(now, timezone);

  return {
    fromDate: addUtcDays(toDate, -6),
    toDate,
    timezone,
  };
}

export function parseDateRange(values: {
  fromDate?: string | string[];
  toDate?: string | string[];
  timezone?: string | string[];
}): DateRange {
  const timezoneInput = first(values.timezone);
  const timezone =
    timezoneInput != null && isTimezoneLike(timezoneInput) ? timezoneInput : "UTC";
  // Resolve the default range in the requested timezone so an unset range matches the local dates
  // the picker produces, rather than UTC "today" (off-by-one for users east/west of UTC).
  const fallback = defaultDateRange(new Date(), timezone);
  const fromDate = first(values.fromDate) ?? fallback.fromDate;
  const toDate = first(values.toDate) ?? fallback.toDate;

  if (
    !isDateOnly(fromDate) ||
    !isDateOnly(toDate) ||
    (timezoneInput != null && !isTimezoneLike(timezoneInput))
  ) {
    return {
      ...fallback,
      warning: "Invalid date query parameters were ignored.",
    };
  }

  if (fromDate > toDate) {
    return {
      ...fallback,
      warning: "The selected range was invalid and was reset to the default week.",
    };
  }

  return { fromDate, toDate, timezone };
}

export function dateOnlyToUtcInstant(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function dayAfterDateOnlyToUtcInstant(date: string): string {
  return dateOnlyToUtcInstant(addUtcDays(date, 1));
}

export function addUtcDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return date;
  const next = new Date(parsed);
  next.setUTCDate(next.getUTCDate() + days);
  return toDateInputValue(next);
}

function first(value?: string | string[]): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isDateOnly(value: string): boolean {
  return dateOnlyPattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function toDateInputValue(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateInputValueInTimeZone(value: Date, timeZone: string): string {
  // "en-CA" formats as YYYY-MM-DD, and the timeZone option yields the calendar date in that zone.
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value);
  } catch {
    return toDateInputValue(value);
  }
}

function isTimezoneLike(value: string): boolean {
  return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$|^UTC$/.test(value);
}
