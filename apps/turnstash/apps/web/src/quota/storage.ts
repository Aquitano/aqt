import { Option, Schema } from "effect";

import type { QuotaAlert, QuotaAlertPreferences } from "./alerts";

export const preferencesKey = "turnstash_quota_alerts_v1";
export const dismissedKey = "turnstash_quota_dismissed_v1";
export const notifiedKey = "turnstash_quota_notified_v1";

const Preferences = Schema.fromJsonString(
  Schema.Struct({
    low: Schema.Boolean,
    unused: Schema.Boolean,
    desktop: Schema.Boolean,
  }),
);
const Receipt = Schema.Struct({
  id: Schema.String,
  until: Schema.Number,
  window: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.String,
      minutes: Schema.Number,
      kind: Schema.Literals(["low", "unused"]),
      observedAt: Schema.Number,
    }),
  ),
});

export const receiptMatchesAlert = (receipt: typeof Receipt.Type, alert: QuotaAlert) =>
  receipt.id === alert.id ||
  (receipt.window !== undefined &&
    receipt.window.provider === alert.provider &&
    receipt.window.minutes === alert.windowMinutes &&
    receipt.window.kind === alert.kind &&
    receipt.window.observedAt >= alert.firstObservedAtMs &&
    receipt.window.observedAt <= alert.lastObservedAtMs);
const decodePreferences = Schema.decodeUnknownOption(Preferences);
const decodeReceipts = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Receipt)));

export const defaultPreferences: QuotaAlertPreferences = {
  low: false,
  unused: false,
  desktop: false,
};
let memoryPreferences = defaultPreferences;
let preferencesWriteFailed = false;
const memoryReceipts = new Map<string, ReadonlyArray<typeof Receipt.Type>>();

export const readPreferences = (): QuotaAlertPreferences => {
  if (preferencesWriteFailed) return memoryPreferences;
  try {
    memoryPreferences = Option.getOrElse(
      decodePreferences(localStorage.getItem(preferencesKey)),
      () => defaultPreferences,
    );
  } catch {
    return memoryPreferences;
  }
  return memoryPreferences;
};

export const savePreferences = (preferences: QuotaAlertPreferences) => {
  memoryPreferences = preferences;
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
    preferencesWriteFailed = false;
  } catch {
    preferencesWriteFailed = true;
  }
};

export const readReceipts = (key: string, nowMs: number) => {
  let receipts = memoryReceipts.get(key) ?? [];
  try {
    const saved = Option.getOrElse(decodeReceipts(localStorage.getItem(key)), () => []);
    receipts = [
      ...new Map([...saved, ...receipts].map((receipt) => [receipt.id, receipt])).values(),
    ];
  } catch {
    // Keep the in-memory receipts when storage is blocked.
  }
  const active = receipts.filter((receipt) => receipt.until > nowMs);
  memoryReceipts.set(key, active);
  return active;
};

export const rememberAlert = (key: string, alert: QuotaAlert, nowMs: number) => {
  const receipts = [
    ...readReceipts(key, nowMs).filter((receipt) => receipt.id !== alert.id),
    {
      id: alert.id,
      until: alert.resetsAtMs + 24 * 3_600_000,
      window: {
        provider: alert.provider,
        minutes: alert.windowMinutes,
        kind: alert.kind,
        observedAt: alert.firstObservedAtMs,
      },
    },
  ];
  memoryReceipts.set(key, receipts);
  try {
    localStorage.setItem(key, JSON.stringify(receipts));
  } catch {
    // The in-memory receipt prevents repeats in this tab.
  }
  return receipts;
};

export const dismissQuotaAlert = async (alert: QuotaAlert) => {
  const remember = () => rememberAlert(dismissedKey, alert, Date.now());
  if ("locks" in navigator) {
    try {
      return await navigator.locks.request("turnstash-quota-notifications", remember);
    } catch {
      return remember();
    }
  }
  return remember();
};
