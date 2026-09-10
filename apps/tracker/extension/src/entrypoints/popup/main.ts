import { type Type, type } from "arktype";
import { browser } from "wxt/browser";

import { element } from "../../lib/dom.ts";
import { CaptureNowReply, StatusReply, type PopupMessage } from "../../lib/messages.ts";

const REFRESH_MS = 2000;

async function ask<t>(
  message: PopupMessage,
  schema: Type<t>,
): Promise<Type<t>["infer"] | undefined> {
  const reply = await browser.runtime.sendMessage<PopupMessage, unknown>(message);
  const decoded = schema(reply);
  return decoded instanceof type.errors ? undefined : decoded;
}

const connection = element("connection", HTMLSpanElement);
const outcome = element("outcome", HTMLParagraphElement);

async function refresh(): Promise<void> {
  const status = await ask({ type: "status" }, StatusReply);
  if (!status) {
    connection.textContent = "background unavailable";
    connection.dataset.state = "unknown";
    return;
  }
  // Signed out is not the same failure as unreachable, and the fix differs:
  // one is a login, the other is a server that is down.
  const state = !status.connected ? "unreachable" : status.auth === "out" ? "out" : "connected";
  connection.textContent = state === "out" ? "signed out" : state;
  connection.dataset.state = state;
  element("pending-events", HTMLElement).textContent = String(status.pendingEvents);
  element("pending-captures", HTMLElement).textContent = String(status.pendingCaptures);
  element("last-sync", HTMLElement).textContent = status.lastSyncAt ?? "never";
  element("last-error", HTMLElement).textContent = status.lastError ?? "-";
  element("dropped", HTMLElement).textContent = String(status.dropped);
  element("log", HTMLPreElement).textContent = status.diagnostics.toReversed().join("\n");
}

async function captureNow(): Promise<void> {
  outcome.textContent = "capturing";
  const reply = await ask({ type: "capture_now" }, CaptureNowReply);
  if (!reply) outcome.textContent = "no reply from background";
  else outcome.textContent = reply.ok ? "capture queued" : reply.error;
  await refresh();
}

element("capture", HTMLButtonElement).addEventListener("click", () => void captureNow());
element("options", HTMLAnchorElement).addEventListener("click", (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
});

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
