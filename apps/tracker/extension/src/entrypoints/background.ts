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
  onSettingsChanged,
  reconcile,
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
  browser.tabs.onActivated.addListener(() => void serialized(() => reconcile("tab_switch")));
  browser.tabs.onRemoved.addListener((tabId) => void serialized(() => onTabRemoved(tabId)));
  browser.windows.onFocusChanged.addListener(() => void serialized(() => reconcile("window_blur")));
  browser.idle.onStateChanged.addListener(() => void serialized(() => reconcile("idle")));
  browser.alarms.onAlarm.addListener((alarm) => void serialized(() => onAlarm(alarm)));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "settings" in changes) void serialized(onSettingsChanged);
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const parsed = BackgroundMessage(message);
    if (parsed instanceof type.errors) return false;
    void serialized(() => handleMessage(parsed, sender)).then(sendResponse);
    return true;
  });

  void serialized(onWorkerStart);
});
