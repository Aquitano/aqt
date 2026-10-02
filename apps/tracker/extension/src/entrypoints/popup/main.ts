import { type Type, type } from "arktype";
import { browser } from "wxt/browser";

import { element } from "../../lib/dom.ts";
import type { ForgetCounts } from "../../lib/events.ts";
import {
  ActionReply,
  ForgetReply,
  StatusReply,
  type ForgetScope,
  type PopupMessage,
} from "../../lib/messages.ts";
import { isPrivateHost } from "../../lib/privacy.ts";
import { searchPagePath } from "../../lib/recall.ts";
import { loadSettings } from "../../lib/storage.ts";

const REFRESH_MS = 2000;
const CONFIRM_MS = 4000;

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
const pauseButton = element("pause", HTMLButtonElement);
const pausedNote = element("paused", HTMLParagraphElement);
const makePrivateButton = element("make-private", HTMLButtonElement);
const forgetPageButton = element("forget-page", HTMLButtonElement);
const forgetHostButton = element("forget-host", HTMLButtonElement);

let paused = false;

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
  paused = status.pausedUntil !== undefined;
  pauseButton.textContent = paused ? "Resume" : "Pause for 1 hour";
  pausedNote.hidden = !paused;
  if (status.pausedUntil !== undefined) {
    const until = new Date(status.pausedUntil);
    pausedNote.textContent = `Paused until ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  element("pending-events", HTMLElement).textContent = String(status.pendingEvents);
  element("pending-captures", HTMLElement).textContent = String(status.pendingCaptures);
  element("last-sync", HTMLElement).textContent = status.lastSyncAt ?? "never";
  element("last-error", HTMLElement).textContent = status.lastError ?? "-";
  element("dropped", HTMLElement).textContent = String(status.dropped);
  element("log", HTMLPreElement).textContent = status.diagnostics.toReversed().join("\n");
}

async function showHostControls(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url === undefined ? undefined : URL.parse(tab.url);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return;
  const isPrivate = isPrivateHost(url.hostname, (await loadSettings()).privateHosts);
  makePrivateButton.textContent = isPrivate
    ? `${url.hostname} is private`
    : `Make ${url.hostname} private`;
  makePrivateButton.disabled = isPrivate;
  forgetPageButton.disabled = false;
  forgetHostButton.textContent = `Forget everything on ${url.hostname}`;
  forgetHostButton.disabled = false;
}

async function act(message: PopupMessage, pending: string, done: string): Promise<void> {
  outcome.textContent = pending;
  const reply = await ask(message, ActionReply);
  if (!reply) outcome.textContent = "no reply from background";
  else outcome.textContent = reply.ok ? done : reply.error;
  await refresh();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeForgotten(counts: ForgetCounts): string {
  const parts = [
    plural(counts.page_views, "page view"),
    plural(counts.spans, "span"),
    plural(counts.captures, "capture"),
    plural(counts.blobs, "blob"),
    plural(counts.records, "record"),
  ];
  return `Server forgot ${parts.join(", ")}`;
}

async function forget(scope: ForgetScope): Promise<void> {
  outcome.textContent = "forgetting";
  const reply = await ask({ type: "forget", scope }, ForgetReply);
  if (!reply) outcome.textContent = "no reply from background";
  else outcome.textContent = reply.ok ? describeForgotten(reply.forgotten) : reply.error;
  await refresh();
}

// A second click confirms: a dialog from an action popup is not reliable.
function onConfirmedClick(button: HTMLButtonElement, run: () => Promise<void>): void {
  let label: string | undefined;
  let disarm: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    clearTimeout(disarm);
    if (label !== undefined) button.textContent = label;
    label = undefined;
  };
  button.addEventListener("click", () => {
    if (label !== undefined) {
      reset();
      void run();
      return;
    }
    label = button.textContent;
    button.textContent = "Click again to forget";
    disarm = setTimeout(reset, CONFIRM_MS);
  });
}

element("capture", HTMLButtonElement).addEventListener(
  "click",
  () => void act({ type: "capture_now" }, "capturing", "capture queued"),
);
pauseButton.addEventListener(
  "click",
  () => void act({ type: paused ? "resume" : "pause" }, "", paused ? "resumed" : "paused"),
);
makePrivateButton.addEventListener("click", () => {
  void (async () => {
    await act({ type: "make_private" }, "", "host made private");
    await showHostControls();
  })();
});
onConfirmedClick(forgetPageButton, () => forget("page"));
onConfirmedClick(forgetHostButton, () => forget("host"));
element("search", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  const query = element("search-query", HTMLInputElement).value.trim();
  if (query !== "") void browser.tabs.create({ url: searchPagePath(query) });
});
element("options", HTMLAnchorElement).addEventListener("click", (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
});

void refresh();
void showHostControls();
setInterval(() => void refresh(), REFRESH_MS);
