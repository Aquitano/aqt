import { type } from "arktype";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { SerializeRequest, type SerializeReply, type UrlChangedMessage } from "../lib/messages.ts";
import { URL_CHANGED_EVENT } from "../lib/url-change-event.ts";

const SERIALIZE_TIMEOUT_MS = 2000;

function report(navigationType: UrlChangedMessage["navigation_type"]): void {
  const message: UrlChangedMessage = {
    type: "url_changed",
    url: location.href,
    navigation_type: navigationType,
  };
  browser.runtime.sendMessage(message).catch(() => undefined);
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  main() {
    let dirty = false;
    new MutationObserver(() => {
      dirty = true;
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
          sendResponse(reply);
        },
        { timeout: SERIALIZE_TIMEOUT_MS },
      );
      return true;
    });
  },
});
