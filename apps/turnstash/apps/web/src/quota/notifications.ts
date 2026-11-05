import type { QuotaAlert } from "./alerts";
import { dismissedKey, notifiedKey, readReceipts, rememberAlert } from "./storage";

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
      const seen = new Set(
        [...readReceipts(notifiedKey, nowMs), ...readReceipts(dismissedKey, nowMs)].map(
          (receipt) => receipt.id,
        ),
      );
      for (const alert of alerts) {
        if (seen.has(alert.id) || alert.resetsAtMs <= nowMs) continue;
        const notification = new Notification(alert.title, {
          body: alert.description,
          tag: alert.id,
        });
        rememberAlert(notifiedKey, alert, nowMs);
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
