import {
  dismissedKey,
  notifiedKey,
  readReceipts,
  receiptMatchesAlert,
  rememberAlert,
} from "./quota-alert-storage";
import type { QuotaAlert } from "./quota-alerts";

export const desktopNotificationsAvailable = () =>
  globalThis.isSecureContext && "Notification" in globalThis && "locks" in navigator;

export const notifyQuotaAlerts = async (
  alerts: ReadonlyArray<QuotaAlert>,
  isCurrent: () => boolean,
  openLimits: (alert: QuotaAlert) => void,
): Promise<string | null> => {
  if (!desktopNotificationsAvailable() || Notification.permission !== "granted") return null;
  try {
    await navigator.locks.request("turnstash-quota-notifications", () => {
      if (!isCurrent()) return;
      const nowMs = Date.now();
      let seen = [...readReceipts(notifiedKey, nowMs), ...readReceipts(dismissedKey, nowMs)];
      for (const alert of alerts) {
        if (
          seen.some((receipt) => receiptMatchesAlert(receipt, alert)) ||
          alert.resetsAtMs <= nowMs
        )
          continue;
        const notification = new Notification(alert.title, {
          body: alert.description,
          tag: alert.id,
        });
        seen = [...readReceipts(dismissedKey, nowMs), ...rememberAlert(notifiedKey, alert, nowMs)];
        notification.addEventListener("click", () => {
          window.focus();
          openLimits(alert);
          notification.close();
        });
      }
    });
    return null;
  } catch {
    return "This browser could not show a desktop notification. In-app alerts are still available.";
  }
};
