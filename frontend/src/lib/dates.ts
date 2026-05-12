export type DateRange = {
  fromDate: string;
  toDate: string;
  warning?: string;
};

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;

export function defaultDateRange(now = new Date()): DateRange {
  const toDate = toDateInputValue(now);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  from.setUTCDate(from.getUTCDate() - 6);

  return {
    fromDate: toDateInputValue(from),
    toDate,
  };
}

export function parseDateRange(values: {
  fromDate?: string | string[];
  toDate?: string | string[];
}): DateRange {
  const fallback = defaultDateRange();
  const fromDate = first(values.fromDate) ?? fallback.fromDate;
  const toDate = first(values.toDate) ?? fallback.toDate;

  if (!isDateOnly(fromDate) || !isDateOnly(toDate)) {
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

  return { fromDate, toDate };
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
