import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { QuotaAlert } from "../src/quota/alerts";
import { notifyQuotaAlerts } from "../src/quota/notifications";
import {
  defaultPreferences,
  dismissedKey,
  notifiedKey,
  preferencesKey,
  readPreferences,
  readReceipts,
  rememberAlert,
  savePreferences,
} from "../src/quota/storage";

const now = Date.UTC(2026, 10, 5, 12);
const alertOf = (id: string): QuotaAlert => ({
  id,
  kind: "low",
  provider: "claude",
  windowMinutes: 300,
  resetsAtMs: now + 3_600_000,
  title: "Claude 5-hour quota is running low",
  description: "10% left.",
});
let storage = new Map<string, string>();
let sent: Array<TestNotification> = [];
let failDelivery = false;
class TestNotification extends EventTarget {
  static permission = "granted";
  readonly close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    if (failDelivery) throw new Error("Not supported");
    sent.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  storage = new Map();
  sent = [];
  failDelivery = false;
  TestNotification.permission = "granted";
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", { focus: vi.fn() });
  vi.stubGlobal("navigator", {
    locks: {
      request: (_name: string, run: () => void) => {
        const next = queue.then(run);
        queue = next.catch(() => undefined);
        return next;
      },
    },
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("missing and invalid preferences default off; saved opt-ins round trip", () => {
  expect(readPreferences()).toEqual(defaultPreferences);
  storage.set(preferencesKey, '{"low":"true"}');
  expect(readPreferences()).toEqual(defaultPreferences);
  storage.set(preferencesKey, "invalid");
  expect(readPreferences()).toEqual(defaultPreferences);
  const preferences = { low: true, unused: false, desktop: true };
  savePreferences(preferences);
  expect(readPreferences()).toEqual(preferences);
});

test("concurrent notification attempts deliver once, and clicking opens the selected limit", async () => {
  const alert = alertOf("concurrent");
  const open = vi.fn();
  expect(
    await Promise.all([
      notifyQuotaAlerts([alert], () => true, open),
      notifyQuotaAlerts([alert], () => true, open),
    ]),
  ).toEqual([null, null]);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(storage.get(notifiedKey) ?? "[]")).toContainEqual({
    id: alert.id,
    until: alert.resetsAtMs + 86_400_000,
  });
  sent[0]?.dispatchEvent(new Event("click"));
  expect(window.focus).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(alert);
  expect(sent[0]?.close).toHaveBeenCalledOnce();
  await notifyQuotaAlerts([alertOf("next-window")], () => true, open);
  expect(sent).toHaveLength(2);
});

test("dismissed, cancelled and permission-denied notifications are not delivered", async () => {
  const dismissed = alertOf("dismissed");
  rememberAlert(dismissedKey, dismissed, now);
  await notifyQuotaAlerts([dismissed], () => true, vi.fn());
  await notifyQuotaAlerts([alertOf("cancelled")], () => false, vi.fn());
  TestNotification.permission = "denied";
  await notifyQuotaAlerts([alertOf("denied")], () => true, vi.fn());
  expect(sent).toHaveLength(0);
});

test("failed delivery returns an error without consuming the notification", async () => {
  const alert = alertOf("failed");
  failDelivery = true;
  expect(await notifyQuotaAlerts([alert], () => true, vi.fn())).toContain(
    "In-app alerts are still available",
  );
  expect(readReceipts(notifiedKey, now).some((receipt) => receipt.id === alert.id)).toBe(false);
  failDelivery = false;
  expect(await notifyQuotaAlerts([alert], () => true, vi.fn())).toBeNull();
  expect(sent).toHaveLength(1);
});

test("failed storage writes still prevent repeats in this tab and receipts expire", async () => {
  storage.set(notifiedKey, "[]");
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: () => {
      throw new Error("Quota exceeded");
    },
  });
  const alert = alertOf("storage-full");
  await notifyQuotaAlerts([alert], () => true, vi.fn());
  await notifyQuotaAlerts([alert], () => true, vi.fn());
  expect(sent).toHaveLength(1);
  expect(readReceipts(notifiedKey, now + 2 * 86_400_000)).toEqual([]);
});
