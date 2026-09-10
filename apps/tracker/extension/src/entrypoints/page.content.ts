import { type } from "arktype";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import {
  SerializeRequest,
  type QuietMessage,
  type SerializeReply,
  type UrlChangedMessage,
} from "../lib/messages.ts";
import { URL_CHANGED_EVENT } from "../lib/url-change-event.ts";

const SERIALIZE_TIMEOUT_MS = 2000;
const QUIET_MS = 30_000;

function send(message: QuietMessage | UrlChangedMessage): void {
  browser.runtime.sendMessage(message).catch(() => undefined);
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main() {
    let dirty = false;
    let serialized = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    function armQuiet(): void {
      if (!serialized) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (dirty) send({ type: "quiet" });
      }, QUIET_MS);
    }

    function report(navigationType: UrlChangedMessage["navigation_type"]): void {
      serialized = false;
      clearTimeout(quietTimer);
      send({ type: "url_changed", url: location.href, navigation_type: navigationType });
    }

    new MutationObserver(() => {
      dirty = true;
      armQuiet();
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    window.addEventListener(URL_CHANGED_EVENT, () => report("spa"));
    window.addEventListener("popstate", () => report("back_forward"));

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (SerializeRequest(message) instanceof type.errors) return false;
      requestIdleCallback(
        () => {
          const reply: SerializeReply = {
            html: document.documentElement.outerHTML,
            title: document.title,
            url: location.href,
            dirty,
          };
          dirty = false;
          serialized = true;
          armQuiet();
          sendResponse(reply);
        },
        { timeout: SERIALIZE_TIMEOUT_MS },
      );
      return true;
    });
  },
});
