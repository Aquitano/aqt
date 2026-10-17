import type { Schema } from "effect";

const dollars = (maximumFractionDigits: number) => {
  const format = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits,
  });
  return (value: number): string => format.format(Number.isFinite(value) ? value : 0);
};

export const usd = dollars(2);

export const preciseUsd = dollars(6);

export const money = (value: number, currency: string): string =>
  (Number.isFinite(value) ? value : 0).toLocaleString(undefined, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  });

export const moneyList = (
  amounts: ReadonlyArray<{ readonly currency: string; readonly amount: number }>,
): string => amounts.map(({ currency, amount }) => money(amount, currency)).join(" + ");

export const int = (value: number): string =>
  Math.round(Number.isFinite(value) ? value : 0).toLocaleString();

export const compact = (value: number): string =>
  (Number.isFinite(value) ? value : 0).toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });

export const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

const msSince = (iso: string | null): number => {
  if (iso === null) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Date.now() - parsed : Number.NaN;
};

export const relativeTime = (iso: string | null): string => {
  if (iso === null) return "never";
  const elapsed = msSince(iso);
  if (!Number.isFinite(elapsed)) return "unknown";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const hoursSince = (iso: string | null): number => {
  const elapsed = msSince(iso);
  return Number.isFinite(elapsed) ? elapsed / 3_600_000 : Number.POSITIVE_INFINITY;
};

export const duration = (fromIso: string, toIso: string): string => {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.round(hours / 24)}d`;
};

export const dateTime = (iso: string): string => {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "—";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const shortId = (id: string, keep = 8): string =>
  id.length <= keep + 2 ? id : `…${id.slice(-keep)}`;

export const truncateStart = (label: string, max = 28): string =>
  label.length <= max ? label : `…${label.slice(-(max - 1))}`;

export const json = (value: Schema.Json): string => JSON.stringify(value, null, 2);
