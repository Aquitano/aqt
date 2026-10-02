import { afterAll, afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { fakeBrowser } from "@webext-core/fake-browser";
import { indexedDB } from "fake-indexeddb";

import type { CapturePayload, PageViewEvent, TrackerEvent } from "./events.ts";
import { forgets } from "./privacy.ts";
import type { Rule } from "./rules.ts";
import { defaultSettings } from "./settings.ts";

Object.assign(globalThis, { chrome: fakeBrowser, browser: fakeBrowser, indexedDB });
const {
  dueEvents,
  enqueueCapture,
  enqueueEvent,
  markFailed,
  nextDueCapture,
  pendingCounts,
  purge,
  removeRows,
} = await import("./outbox.ts");
const { deviceIdStore, openSpanStore, rulesStore, settingsStore, syncStore, tabStore } =
  await import("./storage.ts");
const {
  captureTab,
  flushEvents,
  handleMessage,
  onAlarm,
  onTabRemoved,
  onTitleChanged,
  reconcile,
  requestSync,
  serialized,
  showSeenBefore,
  uploadCaptures,
} = await import("./tracker.ts");

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

test("making an open host private stops sending its title changes", async () => {
  await settingsStore.set({ ...defaultSettings, privateHosts: ["example.org"] });
  await onTitleChanged(1, "Inbox (3)", Date.now());
  expect((await pendingCounts()).events).toBe(0);
});

test("making an open host private leaves only its host as the next page view's referrer", async () => {
  await settingsStore.set({ ...defaultSettings, privateHosts: ["example.org"] });
  const tab = await fakeBrowser.tabs.create({ url: pageURL });
  await handleMessage(
    { type: "url_changed", url: "https://example.org/inbox", navigation_type: "spa" },
    { tab, frameId: 0 },
    Date.now(),
  );
  const [event] = (await dueEvents(100)).map((row) => row.payload);
  expect(event).toMatchObject({ type: "page_view", referrer: "https://example.org/" });
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

async function titlesSent(): Promise<string[]> {
  const titles = (await dueEvents(100)).flatMap(({ payload }) =>
    payload.type === "page_view" && payload.title !== undefined ? [payload.title] : [],
  );
  return titles.toSorted((a, b) => a.localeCompare(b));
}

async function whileServerHangs(run: () => Promise<void>): Promise<void> {
  const answered = Promise.withResolvers<void>();
  fetchRequest.mockImplementation(
    fakeFetch(async () => {
      await answered.promise;
      return Response.json({ ok: true, db: true });
    }),
  );
  try {
    await run();
  } finally {
    answered.resolve();
    await requestSync();
  }
}

test("a changing title goes out at once, then only its latest value on each heartbeat", async () => {
  setSystemTime(new Date(timestamp));
  await openSpanStore.set({
    id: "span",
    pageViewId: pageView.id,
    tabId: 1,
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
  });
  await onTitleChanged(1, "Loading…", Date.now());
  await onTitleChanged(1, "(1) Inbox", Date.now());
  await onTitleChanged(1, "(2) Inbox", Date.now());
  expect(await titlesSent()).toEqual(["Loading…"]);
  await whileServerHangs(async () => {
    await withTabFocused(() =>
      serialized((at) =>
        onAlarm({ name: "heartbeat", scheduledTime: at, persistAcrossSessions: true }, at),
      ),
    );
    expect(await titlesSent()).toEqual(["(2) Inbox", "Loading…"]);
  });
});

test("a title held back for the heartbeat goes out when its tab closes", async () => {
  await tabStore(1).set({
    tabSessionId: "tab",
    pageView: { event: { ...pageView, title: "Loading…" }, titled: true },
  });
  await onTitleChanged(1, "Article", Date.now());
  expect(await titlesSent()).toEqual([]);
  await serialized((at) => onTabRemoved(1, at));
  expect(await titlesSent()).toEqual(["Article"]);
});

function answerVisits(count: number, beforeAnswering = async () => {}) {
  fetchRequest.mockImplementation(
    fakeFetch(async () => {
      await beforeAnswering();
      const last_at = count > 0 ? "2026-09-19T12:00:00.000Z" : null;
      return Response.json({ url: pageURL, visits: { count, last_at, active_seconds: 840 } });
    }),
  );
}

test("a page seen before shows how often on its tab's badge", async () => {
  setSystemTime(new Date(timestamp));
  answerVisits(3);
  await showSeenBefore(1, pageView);
  const [input = ""] = fetchRequest.mock.calls[0] ?? [];
  const asked = new URL(input instanceof Request ? input.url : input);
  expect([asked.pathname, asked.searchParams.get("url"), asked.searchParams.get("before")]).toEqual(
    ["/v1/visits", pageURL, timestamp],
  );
  expect(await fakeBrowser.action.getBadgeText({ tabId: 1 })).toBe("3");
  expect(await fakeBrowser.action.getTitle({ tabId: 1 })).toBe(
    "Seen 3 times, last 2 days ago, 14 min in total",
  );
});

test("an answer about a page view the tab has already left is not shown", async () => {
  answerVisits(3, () =>
    tabStore(1).set({
      tabSessionId: "tab",
      pageView: { event: { ...pageView, id: "next" }, titled: false },
    }),
  );
  await showSeenBefore(1, pageView);
  expect(await fakeBrowser.action.getBadgeText({ tabId: 1 })).toBe("");
});

test("navigating clears the badge before the next page's answer arrives", async () => {
  await fakeBrowser.action.setBadgeText({ tabId: 1, text: "3" });
  const tab = await fakeBrowser.tabs.create({ url: pageURL });
  await handleMessage(
    { type: "url_changed", url: "https://example.org/next", navigation_type: "spa" },
    { tab, frameId: 0 },
    Date.now(),
  );
  expect(await fakeBrowser.action.getBadgeText({ tabId: 1 })).toBe("");
});

test("a private page view is never looked up", async () => {
  answerVisits(3);
  await showSeenBefore(1, { ...pageView, url: "https://example.org/", private: true });
  expect(fetchRequest).not.toHaveBeenCalled();
});

test("pausing ends the open span at that moment and turns the badge off", async () => {
  setSystemTime(new Date(timestamp));
  await openSpanStore.set({
    id: "span",
    pageViewId: pageView.id,
    tabId: 1,
    startedAt: fiveMinutesBefore,
    lastHeartbeatAt: timestamp,
  });
  await serialized((at) => handleMessage({ type: "pause" }, {}, at));
  expect((await dueEvents(100)).map((row) => row.payload)).toEqual([
    { type: "span_end", id: "span", ended_at: timestamp, reason: "paused" },
  ]);
  expect((await settingsStore.get())?.pausedUntil).toBe(Date.parse(timestamp) + 3_600_000);
  expect(await fakeBrowser.action.getBadgeText({})).toBe("off");
});

test("while paused, focus, titles, navigations and captures record nothing", async () => {
  await settingsStore.set({ ...defaultSettings, pausedUntil: Date.now() + 60_000 });
  const tab = await fakeBrowser.tabs.create({ url: pageURL });
  expect(await captureTab(1, "manual")).toEqual({ ok: false, error: "tracking is paused" });
  await withTabFocused(async () => {
    await serialized((at) => reconcile("tab_switch", at));
    await serialized((at) => onTitleChanged(1, "Inbox (1)", at));
    await serialized((at) =>
      handleMessage(
        { type: "url_changed", url: "https://example.org/next", navigation_type: "spa" },
        { tab, frameId: 0 },
        at,
      ),
    );
  });
  expect(await dueEvents(100)).toEqual([]);
  expect((await pendingCounts()).captures).toBe(0);
});

test("the first heartbeat after the pause has passed records again and clears the badge", async () => {
  setSystemTime(new Date(timestamp));
  await settingsStore.set({ ...defaultSettings, pausedUntil: Date.parse(timestamp) - 1 });
  await fakeBrowser.action.setBadgeText({ text: "off" });
  await whileServerHangs(async () => {
    await withTabFocused(() =>
      serialized((at) =>
        onAlarm({ name: "heartbeat", scheduledTime: at, persistAcrossSessions: true }, at),
      ),
    );
    expect((await dueEvents(100)).map((row) => row.payload.type)).toContain("span_start");
  });
  expect((await settingsStore.get())?.pausedUntil).toBeUndefined();
  expect(await fakeBrowser.action.getBadgeText({})).toBe("");
});

test("making the active tab's host private moves the tab to a host-only page view at once", async () => {
  setSystemTime(new Date(timestamp));
  await fakeBrowser.tabs.create({ url: pageURL });
  await openSpanStore.set({
    id: "span",
    pageViewId: pageView.id,
    tabId: 1,
    startedAt: timestamp,
    lastHeartbeatAt: timestamp,
  });
  await withTabFocused(() => serialized((at) => handleMessage({ type: "make_private" }, {}, at)));
  expect((await settingsStore.get())?.privateHosts).toEqual(["example.org"]);
  const events = (await dueEvents(100)).map((row) => row.payload);
  const hostOnly = events.find((event) => event.type === "page_view");
  expect(hostOnly).toMatchObject({
    url: "https://example.org/",
    private: true,
    referrer: "https://example.org/",
  });
  expect(hostOnly).not.toHaveProperty("title");
  expect(events).toContainEqual({
    type: "span_end",
    id: "span",
    ended_at: timestamp,
    reason: "navigation",
  });
  expect(events.find((event) => event.type === "span_start")).toMatchObject({
    page_view_id: hostOnly!.id,
    started_at: timestamp,
  });
});

function captureOf(pageViewId: string, url: string): CapturePayload {
  return {
    meta: {
      capture_id: `capture-${pageViewId}`,
      page_view_id: pageViewId,
      device_id: "device",
      captured_at: timestamp,
      url,
      extractor: "article",
      reason: "initial",
      raw_char_count: page.html.length,
    },
    html: page.html,
  };
}

test("forgetting a page drops its queued page views, spans and captures, and referrers to it", async () => {
  const otherURL = "https://example.org/other";
  const queued: TrackerEvent[] = [
    pageView,
    { type: "span_start", id: "span", page_view_id: pageView.id, started_at: timestamp },
    { type: "span_heartbeat", id: "span", at: timestamp },
    { type: "span_end", id: "span", ended_at: timestamp, reason: "tab_switch" },
    { ...pageView, id: "other", url: otherURL, referrer: `${pageURL}#comments` },
    { type: "span_start", id: "kept", page_view_id: "other", started_at: timestamp },
  ];
  await Promise.all(queued.map((event) => enqueueEvent(event)));
  await enqueueCapture(captureOf(pageView.id, pageURL));
  await enqueueCapture(captureOf("uploaded", `${pageURL}#top`));
  await enqueueCapture(captureOf("other", otherURL));
  await purge(forgets({ url: pageURL }), new Set());
  const left = (await dueEvents(100)).map((row) => row.payload);
  expect(left).toHaveLength(2);
  expect(left).toContainEqual({ ...pageView, id: "other", url: otherURL });
  expect(left).toContainEqual({
    type: "span_start",
    id: "kept",
    page_view_id: "other",
    started_at: timestamp,
  });
  expect((await pendingCounts()).captures).toBe(1);
  expect((await nextDueCapture())?.payload.meta.page_view_id).toBe("other");
});
