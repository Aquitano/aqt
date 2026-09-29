import { afterAll, afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { fakeBrowser } from "@webext-core/fake-browser";
import { indexedDB } from "fake-indexeddb";

import { defaultSettings } from "./settings.ts";

Object.assign(globalThis, { chrome: fakeBrowser, browser: fakeBrowser, indexedDB });
const { checkHealth } = await import("./api.ts");
const { dueEvents, enqueueEvent, markFailed, pendingCounts } = await import("./outbox.ts");
const { deviceIdStore, openSpanStore, rulesStore, settingsStore, syncStore, tabStore } =
  await import("./storage.ts");
const { captureTab, flushEvents, reconcile, serialized } = await import("./tracker.ts");

const pageURL = "https://example.org/article";
const timestamp = "2026-09-21T12:00:00.000Z";
const page = { html: "<html>Article</html>", title: "Article", url: pageURL, dirty: true };
const originalFetch = globalThis.fetch;
const sendMessage = spyOn(fakeBrowser.tabs, "sendMessage");
const fetchRequest = spyOn(globalThis, "fetch");

beforeEach(async () => {
  fakeBrowser.reset();
  sendMessage.mockReset();
  sendMessage.mockImplementation(async () => page);
  fetchRequest.mockReset();
  fetchRequest.mockResolvedValue(Response.json({ accepted: 0, dropped: 1 }));
  await settingsStore.set(defaultSettings);
  await syncStore.set({ connected: true });
  await deviceIdStore.set("device");
  await rulesStore.set({
    fetchedAt: timestamp,
    rules: [
      {
        extractor: "article",
        version: 1,
        hosts: ["*"],
        path_regex: "",
        query_keys: [],
        dwell_ms: 30000,
        recapture: "never",
        max_bytes: 1000000,
      },
    ],
  });
  await tabStore(1).set({
    tabSessionId: "tab",
    pageView: {
      event: {
        type: "page_view",
        id: "page",
        url: pageURL,
        started_at: timestamp,
        navigation_type: "load",
        tab_session_id: "tab",
        private: false,
      },
      titled: false,
    },
  });
  await pendingCounts();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("tracker-outbox");
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction(["events", "captures"], "readwrite");
      transaction.objectStore("events").clear();
      transaction.objectStore("captures").clear();
      transaction.addEventListener("complete", () => {
        db.close();
        resolve();
      });
      transaction.addEventListener("error", () => reject(transaction.error));
    });
    request.addEventListener("error", () => reject(request.error));
  });
});

afterEach(() => setSystemTime());
afterAll(() => {
  sendMessage.mockRestore();
  fetchRequest.mockRestore();
});

test("making an open host private prevents capture before serialization", async () => {
  await settingsStore.set({ ...defaultSettings, privateHosts: ["example.org"] });
  expect(await captureTab(1, "manual")).toEqual({ ok: false, error: "private host" });
  expect(sendMessage).not.toHaveBeenCalled();
  expect((await pendingCounts()).captures).toBe(0);
});

test("capture rejects a document from a navigation that has not been handled yet", async () => {
  sendMessage.mockImplementation(async () => ({
    ...page,
    url: "https://secret.example.org/account",
  }));
  expect((await captureTab(1, "initial")).ok).toBe(false);
  expect((await pendingCounts()).captures).toBe(0);
});

test("capture rechecks privacy after the content script replies", async () => {
  sendMessage.mockImplementation(async () => {
    await settingsStore.set({ ...defaultSettings, privateHosts: ["example.org"] });
    return page;
  });
  expect(await captureTab(1, "manual")).toEqual({ ok: false, error: "private host" });
  expect((await pendingCounts()).captures).toBe(0);
});

test("a span that outlived a sleep ends at its last heartbeat, not at the wake", async () => {
  const { windows, tabs, idle } = fakeBrowser;
  const originals = {
    getLastFocused: windows.getLastFocused,
    query: tabs.query,
    queryState: idle.queryState,
  };
  Object.assign(windows, { getLastFocused: async () => ({ id: 1, focused: true }) });
  Object.assign(tabs, { query: async () => [{ id: 1, url: pageURL, incognito: false }] });
  Object.assign(idle, { queryState: async () => "active" });
  const lastHeartbeatAt = "2026-09-21T22:00:00.000Z";
  await openSpanStore.set({
    id: "night",
    pageViewId: "page",
    tabId: 1,
    startedAt: lastHeartbeatAt,
    lastHeartbeatAt,
  });
  try {
    setSystemTime(new Date("2026-09-22T06:00:00.000Z"));
    await serialized(() => reconcile("unknown"));
    const events = (await dueEvents(100)).map((row) => row.payload);
    expect(events).toContainEqual({
      type: "span_end",
      id: "night",
      ended_at: lastHeartbeatAt,
      reason: "unknown",
    });
  } finally {
    Object.assign(windows, { getLastFocused: originals.getLastFocused });
    Object.assign(tabs, { query: originals.query });
    Object.assign(idle, { queryState: originals.queryState });
  }
});

test("events waiting for retry keep their dependent events behind them", async () => {
  await enqueueEvent({
    type: "span_start",
    id: "span",
    page_view_id: "page",
    started_at: timestamp,
  });
  const failed = await dueEvents(100);
  await markFailed("events", failed);
  setSystemTime(Date.now() + 1);
  await enqueueEvent({ type: "span_end", id: "span", ended_at: timestamp, reason: "tab_switch" });
  expect(await dueEvents(100)).toEqual([]);
  setSystemTime(Date.now() + 300000);
  expect((await dueEvents(100)).map((row) => row.payload.type)).toEqual(["span_start", "span_end"]);
});

test("the extension counts events the server drops", async () => {
  await enqueueEvent({ type: "span_heartbeat", id: "missing", at: timestamp });
  await flushEvents();
  expect((await syncStore.get())?.dropped).toBe(1);
  expect((await pendingCounts()).events).toBe(0);
});

test("a timed out request releases the serialized event queue", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
        once: true,
      });
      controller.abort();
    });
  fetchRequest.mockImplementation(
    Object.assign(hangingFetch, { preconnect: originalFetch.preconnect }),
  );
  try {
    const request = serialized(() => checkHealth(defaultSettings.serverUrl));
    const following = serialized(async () => "processed");
    expect((await request)?.ok).toBe(false);
    expect(await following).toBe("processed");
  } finally {
    timeout.mockRestore();
  }
}, 1000);
