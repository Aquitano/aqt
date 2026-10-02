import { type } from "arktype";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";

import { BackgroundMessage } from "../lib/messages.ts";
import {
  IDLE_SECONDS,
  handleMessage,
  onAlarm,
  onBrowserStartup,
  onCommitted,
  onHistoryStateUpdated,
  onInstalled,
  onTabRemoved,
  onTitleChanged,
  onWorkerStart,
  onIdleStateChanged,
  reconcile,
  requestSync,
  serialized,
} from "../lib/tracker.ts";

export default defineBackground(() => {
  browser.idle.setDetectionInterval(IDLE_SECONDS);

  browser.runtime.onInstalled.addListener(() => void serialized(onInstalled));
  browser.runtime.onStartup.addListener(() => void serialized(onBrowserStartup));

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) void serialized(() => onCommitted(details));
  });
  browser.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) void serialized(() => onHistoryStateUpdated(details));
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const title = changeInfo.title;
    if (title !== undefined) void serialized(() => onTitleChanged(tabId, title));
  });
  browser.tabs.onActivated.addListener(() => void serialized((at) => reconcile("tab_switch", at)));
  browser.tabs.onRemoved.addListener((tabId) => void serialized((at) => onTabRemoved(tabId, at)));
  browser.windows.onFocusChanged.addListener(
    () => void serialized((at) => reconcile("window_blur", at)),
  );
  browser.idle.onStateChanged.addListener(
    (state) => void serialized((at) => onIdleStateChanged(state, at)),
  );
  browser.alarms.onAlarm.addListener((alarm) => void serialized((at) => onAlarm(alarm, at)));
  browser.storage.onChanged.addListener((changes, area) => {
    // Signing in changes authTokens, not settings, and should take effect at
    // once rather than at the next hourly rules alarm.
    if (area !== "local") return;
    if ("settings" in changes || "authTokens" in changes) void requestSync(["rules", "health"]);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const parsed = BackgroundMessage(message);
    if (parsed instanceof type.errors) return false;
    void serialized((at) => handleMessage(parsed, sender, at)).then(sendResponse);
    return true;
  });

  void serialized(onWorkerStart);
});
