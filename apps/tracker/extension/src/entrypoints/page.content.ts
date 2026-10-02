import { type } from "arktype";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { SerializeRequest, type SerializeReply, type UrlChangedMessage } from "../lib/messages.ts";
import {
  TRANSCRIPT_EVENT,
  TRANSCRIPT_REQUEST_EVENT,
  type Transcript,
  TranscriptReply,
  withTranscript,
} from "../lib/transcript.ts";
import { URL_CHANGED_EVENT } from "../lib/url-change-event.ts";

const SERIALIZE_TIMEOUT_MS = 2000;
const TRANSCRIPT_TIMEOUT_MS = 5000;

function report(navigationType: UrlChangedMessage["navigation_type"]): void {
  const message: UrlChangedMessage = {
    type: "url_changed",
    url: location.href,
    navigation_type: navigationType,
  };
  browser.runtime.sendMessage(message).catch(() => undefined);
}

// A page-world script that can supply a transcript claims the request by
// cancelling it, so every other page is serialised without waiting.
function requestTranscript(): Promise<Transcript | undefined> {
  return new Promise((resolve) => {
    const finish = (transcript?: Transcript) => {
      clearTimeout(timer);
      window.removeEventListener(TRANSCRIPT_EVENT, onReply);
      resolve(transcript);
    };
    const onReply = (event: Event) => {
      const reply = event instanceof CustomEvent ? TranscriptReply(event.detail) : undefined;
      finish(reply instanceof type.errors ? undefined : reply);
    };
    window.addEventListener(TRANSCRIPT_EVENT, onReply);
    const timer = setTimeout(finish, TRANSCRIPT_TIMEOUT_MS);
    if (window.dispatchEvent(new Event(TRANSCRIPT_REQUEST_EVENT, { cancelable: true }))) finish();
  });
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
      void requestTranscript().then((transcript) =>
        requestIdleCallback(
          () => {
            const html = document.documentElement.outerHTML;
            const reply: SerializeReply = {
              html: transcript ? withTranscript(html, transcript) : html,
              title: document.title,
              url: location.href,
              dirty,
            };
            dirty = false;
            sendResponse(reply);
          },
          { timeout: SERIALIZE_TIMEOUT_MS },
        ),
      );
      return true;
    });
  },
});
