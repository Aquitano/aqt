import { defineContentScript } from "wxt/utils/define-content-script";

import { URL_CHANGED_EVENT } from "../lib/url-change-event.ts";

function hook(method: "pushState" | "replaceState"): void {
  const original = history[method];
  history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
    original.apply(this, args);
    window.dispatchEvent(new Event(URL_CHANGED_EVENT));
  };
}

// Runs in the page's own world: only there does patching history reach the app's calls.
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    hook("pushState");
    hook("replaceState");
  },
});
