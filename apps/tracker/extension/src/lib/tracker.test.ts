import { afterAll, afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { fakeBrowser } from "@webext-core/fake-browser";
import { indexedDB } from "fake-indexeddb";

import type { PageViewEvent } from "./events.ts";
import type { Rule } from "./rules.ts";
import { defaultSettings } from "./settings.ts";

Object.assign(globalThis, { chrome: fakeBrowser, browser: fakeBrowser, indexedDB });
const { dueEvents, enqueueCapture, enqueueEvent, markFailed, pendingCounts, removeRows } =
  await import("./outbox.ts");
const { deviceIdStore, openSpanStore, rulesStore, settingsStore, syncStore, tabStore } =
  await import("./storage.ts");
const { captureTab, flushEvents, onAlarm, reconcile, requestSync, serialized, uploadCaptures } =
  await import("./tracker.ts");

const pageURL = "https://example.org/article";
const timestamp = "2026-09-21T12:00:00.000Z";
const page = { html: "<html>Article</html>", title: "Article", url: pageURL, dirty: true };
const pageView: PageViewEvent = {
  type: "page_view",
  id: "page",
  url: pageURL,
  started_at: timestamp,
  navigation_type: "load",
  tab_session_id: "tab",
  private: false,
};
const article: Rule = {
  extractor: "article",
  version: 1,
  hosts: ["*"],
  path_regex: "",
  query_keys: [],
  dwell_ms: 30000,
  recapture: "never",
  max_bytes: 1000000,
};
const originalFetch = globalThis.fetch;
const sendMessage = spyOn(fakeBrowser.tabs, "sendMessage");
const fetchRequest = spyOn(globalThis, "fetch");

function fakeFetch(respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return Object.assign(respond, { preconnect: originalFetch.preconnect });
}

beforeEach(async () => {
  fakeBrowser.reset();
  sendMessage.mockReset();
  sendMessage.mockImplementation(async () => page);
  fetchRequest.mockReset();
  fetchRequest.mockResolvedValue(Response.json({ accepted: 0, dropped: 1 }));
  await settingsStore.set(defaultSettings);
  await syncStore.set({ connected: true });
  await deviceIdStore.set("device");
  await rulesStore.set({ fetchedAt: timestamp, rules: [article] });
  await tabStore(1).set({ tabSessionId: "tab", pageView: { event: pageView, titled: false } });
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

async function withTabFocused<T>(run: () => Promise<T>): Promise<T> {
  const { windows, tabs, idle } = fakeBrowser;
  const originals = {
    getLastFocused: windows.getLastFocused,
    query: tabs.query,
    queryState: idle.queryState,
  };
  Object.assign(windows, { getLastFocused: async () => ({ id: 1, focused: true }) });
  Object.assign(tabs, { query: async () => [{ id: 1, url: pageURL, incognito: false }] });
  Object.assign(idle, { queryState: async () => "active" });
  try {
    return await run();
  } finally {
    Object.assign(windows, { getLastFocused: originals.getLastFocused });
    Object.assign(tabs, { query: originals.query });
    Object.assign(idle, { queryState: originals.queryState });
  }
}

test("a span that outlived a sleep ends at its last heartbeat, not at the wake", async () => {
  const lastHeartbeatAt = "2026-09-21T22:00:00.000Z";
  await openSpanStore.set({
    id: "night",
    pageViewId: "page",
    tabId: 1,
    startedAt: lastHeartbeatAt,
    lastHeartbeatAt,
  });
  setSystemTime(new Date("2026-09-22T06:00:00.000Z"));
  await withTabFocused(() => serialized((at) => reconcile("unknown", at)));
  const events = (await dueEvents(100)).map((row) => row.payload);
  expect(events).toContainEqual({
    type: "span_end",
    id: "night",
    ended_at: lastHeartbeatAt,
    reason: "unknown",
  });
});

test("a handler that runs late records when its event fired", async () => {
  const startedAt = "2026-09-21T11:59:30.000Z";
  await openSpanStore.set({
    id: "span",
    pageViewId: "page",
    tabId: 1,
    startedAt,
    lastHeartbeatAt: startedAt,
  });
  setSystemTime(new Date(timestamp));
  const busy = Promise.withResolvers<void>();
  void serialized(() => busy.promise);
  const switched = serialized((at) => reconcile("tab_switch", at));
  setSystemTime(new Date("2026-09-21T12:00:20.000Z"));
  busy.resolve();
  await switched;
  expect((await dueEvents(100)).map((row) => row.payload)).toContainEqual({
    type: "span_end",
    id: "span",
    ended_at: timestamp,
    reason: "tab_switch",
  });
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

test("a failed upload does not bring back a row the full outbox evicted meanwhile", async () => {
  await enqueueEvent(pageView);
  const inFlight = await dueEvents(100);
  await removeRows(
    "events",
    inFlight.map((row) => row.id),
  );
  await markFailed("events", inFlight);
  expect((await pendingCounts()).events).toBe(0);
});

test("a capture waits until the page view it references has left the outbox", async () => {
  await enqueueEvent(pageView);
  await markFailed("events", await dueEvents(100));
  await enqueueCapture({
    meta: {
      capture_id: "capture",
      page_view_id: pageView.id,
      device_id: "device",
      captured_at: timestamp,
      url: pageURL,
      extractor: "article",
      reason: "initial",
      raw_char_count: page.html.length,
    },
    html: page.html,
  });
  await uploadCaptures();
  expect(fetchRequest).not.toHaveBeenCalled();
  expect((await pendingCounts()).captures).toBe(1);
});

test("the extension counts events the server drops", async () => {
  await enqueueEvent({ type: "span_heartbeat", id: "missing", at: timestamp });
  await flushEvents();
  expect((await syncStore.get())?.dropped).toBe(1);
  expect((await pendingCounts()).events).toBe(0);
});

test("a hanging server does not hold up the handlers queued behind it", async () => {
  const requested = Promise.withResolvers<void>();
  const answered = Promise.withResolvers<void>();
  fetchRequest.mockImplementation(
    fakeFetch(async () => {
      requested.resolve();
      await answered.promise;
      return Response.json({ ok: true, db: true });
    }),
  );
  await serialized((at) =>
    onAlarm({ name: "heartbeat", scheduledTime: at, persistAcrossSessions: true }, at),
  );
  await requested.promise;
  expect(await serialized(async () => "handled")).toBe("handled");
  answered.resolve();
  await requestSync();
}, 1000);

test("sync requests during a run coalesce into one follow-up run", async () => {
  fetchRequest.mockImplementation(fakeFetch(async () => Response.json({ ok: true, db: true })));
  const run = requestSync(["health"]);
  void requestSync(["health"]);
  void requestSync(["health"]);
  await run;
  expect(fetchRequest).toHaveBeenCalledTimes(2);
});

test("a timed out request releases the sync", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  fetchRequest.mockImplementation(
    fakeFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), {
            once: true,
          });
          controller.abort();
        }),
    ),
  );
  try {
    await requestSync(["health"]);
    expect((await syncStore.get())?.connected).toBe(false);
  } finally {
    timeout.mockRestore();
  }
}, 1000);

const fiveMinutesBefore = "2026-09-21T11:55:00.000Z";

async function endSpanOnPageCapturedAt(
  lastCapturedAt: string,
  recapture: Rule["recapture"] = "after_change",
): Promise<string | undefined> {
  setSystemTime(new Date(timestamp));
  await rulesStore.set({ fetchedAt: timestamp, rules: [{ ...article, recapture }] });
  await tabStore(1).set({
    tabSessionId: "tab",
    pageView: { event: pageView, titled: false, lastCapturedAt },
  });
  await openSpanStore.set({
    id: "span",
    pageViewId: pageView.id,
    tabId: 1,
    startedAt: lastCapturedAt,
    lastHeartbeatAt: timestamp,
  });
  await serialized((at) => reconcile("tab_switch", at));
  await serialized(() => Promise.resolve());
  await requestSync();
  return (await tabStore(1).get())?.pageView?.lastCapturedAt;
}

test("a span end recaptures a changing page last captured 5 minutes before", async () => {
  expect(await endSpanOnPageCapturedAt(fiveMinutesBefore)).toBe(timestamp);
});

test("a span end within 5 minutes of the last capture does not recapture", async () => {
  const fourMinutesBefore = "2026-09-21T11:56:00.000Z";
  expect(await endSpanOnPageCapturedAt(fourMinutesBefore)).toBe(fourMinutesBefore);
  expect(sendMessage).not.toHaveBeenCalled();
});

test("a span end does not recapture a page that has not changed", async () => {
  sendMessage.mockImplementation(async () => ({ ...page, dirty: false }));
  expect(await endSpanOnPageCapturedAt(fiveMinutesBefore)).toBe(fiveMinutesBefore);
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

test("a span end does not recapture a page whose rule never recaptures", async () => {
  expect(await endSpanOnPageCapturedAt(fiveMinutesBefore, "never")).toBe(fiveMinutesBefore);
  expect(sendMessage).not.toHaveBeenCalled();
});

test("a heartbeat recaptures a changing page the span has stayed on for 5 minutes", async () => {
  setSystemTime(new Date(timestamp));
  await rulesStore.set({
    fetchedAt: timestamp,
    rules: [{ ...article, recapture: "after_change" }],
  });
  await tabStore(1).set({
    tabSessionId: "tab",
    pageView: { event: pageView, titled: false, lastCapturedAt: fiveMinutesBefore },
  });
  await openSpanStore.set({
    id: "span",
    pageViewId: pageView.id,
    tabId: 1,
    startedAt: fiveMinutesBefore,
    lastHeartbeatAt: "2026-09-21T11:59:30.000Z",
  });
  await withTabFocused(async () => {
    await serialized((at) =>
      onAlarm({ name: "heartbeat", scheduledTime: at, persistAcrossSessions: true }, at),
    );
    await serialized(() => Promise.resolve());
  });
  await requestSync();
  expect((await openSpanStore.get())?.id).toBe("span");
  expect((await tabStore(1).get())?.pageView?.lastCapturedAt).toBe(timestamp);
});
