import { type } from "arktype";
import { browser, type Browser } from "wxt/browser";

import {
  checkHealth,
  fetchRules,
  fetchVisits,
  postCapture,
  postEvents,
  postForget,
  type Result,
} from "./api.ts";
import { authState } from "./auth.ts";
import { errorMessage } from "./errors.ts";
import type {
  CaptureMeta,
  CaptureReason,
  EndReason,
  PageViewEvent,
  TrackerEvent,
} from "./events.ts";
import {
  SerializeReply,
  type ActionReply,
  type BackgroundMessage,
  type ForgetMessage,
  type ForgetReply,
  type ForgetScope,
  type SerializeRequest,
  type StatusReply,
} from "./messages.ts";
import {
  dueEvents,
  enqueueCapture,
  enqueueEvent,
  markFailed,
  nextDueCapture,
  pendingCounts,
  purge,
  removeRows,
} from "./outbox.ts";
import { isNewPageView, navigationTypeFor, spaNavigationType } from "./page-view.ts";
import { forgets, isPrivateHost, privateUrl, type ForgetTarget } from "./privacy.ts";
import { describeVisits } from "./recall.ts";
import { isPermanentFailure } from "./result.ts";
import { matchRule, type Rule } from "./rules.ts";
import { isPaused } from "./settings.ts";
import {
  countDropped,
  deviceIdStore,
  diag,
  diagnostics,
  loadSettings,
  openSpanStore,
  rulesStore,
  settingsStore,
  syncStore,
  tabStore,
  updateSync,
  type OpenSpan,
  type PageViewState,
} from "./storage.ts";
import { uuidv7 } from "./uuid.ts";

const HEARTBEAT_ALARM = "heartbeat";
const RULES_ALARM = "rules";
const CAPTURE_ALARM_PREFIX = "capture:";
export const IDLE_SECONDS = 60;
const FLUSH_DELAY_MS = 10_000;
const FLUSH_BATCH = 100;
const STALE_SPAN_MS = 90_000;
const RECAPTURE_INTERVAL_MS = 5 * 60_000;
const PAUSE_MS = 60 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const now = () => iso(Date.now());
const failure = (error: string) => ({ ok: false, error }) satisfies ActionReply;
const captureAlarm = (tabId: number, pageViewId: string) =>
  `${CAPTURE_ALARM_PREFIX}${tabId}:${pageViewId}`;

let chain: Promise<void> = Promise.resolve();

// Every handler runs through one queue so storage read-modify-write cycles
// never interleave. Queued tasks stay short and local: network calls go through
// requestSync, which queues its own storage writes, so a task awaiting a sync
// would wait on itself. A task gets the time it was queued, which for a handler
// is when its event fired; it may run well after that.
export function serialized<T>(task: (queuedAt: number) => Promise<T>): Promise<T | undefined> {
  const queuedAt = Date.now();
  const run = chain.then(async () => {
    try {
      return await task(queuedAt);
    } catch (error) {
      await diag(`error: ${errorMessage(error)}`);
      return undefined;
    }
  });
  chain = run.then(() => undefined);
  return run;
}

async function deviceId(): Promise<string> {
  const existing = await deviceIdStore.get();
  if (existing) return existing;
  const fresh = uuidv7();
  await deviceIdStore.set(fresh);
  await diag(`device id ${fresh}`);
  return fresh;
}

async function ensureAlarms(): Promise<void> {
  if (!(await browser.alarms.get(HEARTBEAT_ALARM))) {
    await browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  }
  if (!(await browser.alarms.get(RULES_ALARM))) {
    await browser.alarms.create(RULES_ALARM, { periodInMinutes: 60 });
  }
}

type SyncStep = "rules" | "health";

let syncSteps: Set<SyncStep> | undefined;
let syncing: Promise<void> | undefined;

// Network calls run here rather than in the handler queue, so a slow or
// unreachable server never holds up tab and span handling. One run at a time:
// requests made during a run merge into a single follow-up run, which the
// returned promise covers.
export function requestSync(steps: readonly SyncStep[] = []): Promise<void> {
  syncSteps = new Set([...(syncSteps ?? []), ...steps]);
  syncing ??= drainSync();
  return syncing;
}

async function drainSync(): Promise<void> {
  const steps = syncSteps;
  syncSteps = undefined;
  if (!steps) {
    syncing = undefined;
    return;
  }
  try {
    if (steps.has("rules")) await refreshRules();
    if (steps.has("health")) await pollHealth();
    await flushEvents();
    await uploadCaptures();
  } catch (error) {
    await serialized(() => diag(`sync error: ${errorMessage(error)}`));
  }
  return drainSync();
}

async function refreshRules(): Promise<void> {
  const settings = await loadSettings();
  const result = await fetchRules(settings.serverUrl);
  await serialized(async () => {
    if (!result.ok) {
      await updateSync({ lastError: result.error });
      await diag(`rules: ${result.error}`);
      return;
    }
    await rulesStore.set({ fetchedAt: now(), rules: result.value });
    await diag(`rules: ${result.value.length} cached`);
  });
}

async function cachedRules(): Promise<Rule[]> {
  return (await rulesStore.get())?.rules ?? [];
}

function ruleFor(rules: readonly Rule[], url: string): Rule | undefined {
  const parsed = URL.parse(url);
  return parsed ? matchRule(rules, parsed) : undefined;
}

async function pollHealth(): Promise<void> {
  const settings = await loadSettings();
  const result = await checkHealth(settings.serverUrl);
  const connected = result.ok && result.value.ok;
  await serialized(async () => {
    const before = (await syncStore.get())?.connected ?? false;
    if (connected) await updateSync({ connected });
    else
      await updateSync({
        connected,
        lastError: result.ok ? "healthz reports not ok" : result.error,
      });
    if (connected && !before) await diag("server reachable");
    if (!connected && before) await diag("server unreachable, queueing until it answers");
  });
}

let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    void requestSync();
  }, FLUSH_DELAY_MS);
}

async function reportEvicted(kind: string, evicted: number): Promise<void> {
  if (evicted === 0) return;
  await countDropped(evicted);
  await diag(`outbox full, dropped ${evicted} oldest ${kind}`);
}

async function emit(event: TrackerEvent): Promise<void> {
  await reportEvicted("events", await enqueueEvent(event));
  const { events } = await pendingCounts();
  if (events >= FLUSH_BATCH) void requestSync();
  else scheduleFlush();
}

export async function flushEvents(): Promise<void> {
  const batch = await dueEvents(FLUSH_BATCH);
  if (batch.length === 0) return;
  const settings = await loadSettings();
  const device = await serialized(deviceId);
  if (device === undefined) return;
  const result = await postEvents(
    settings.serverUrl,
    device,
    batch.map((row) => row.payload),
  );
  await serialized(async () => {
    const ids = batch.map((row) => row.id);
    if (!result.ok) {
      if (isPermanentFailure(result.status)) {
        await removeRows("events", ids);
        await countDropped(batch.length);
        await diag(`events batch dropped (${batch.length} events): ${result.error}`);
      } else {
        await markFailed("events", batch);
      }
      await updateSync({ lastError: result.error });
      return;
    }
    await removeRows("events", ids);
    if (result.value.dropped > 0) {
      await countDropped(result.value.dropped);
      await diag(`server dropped ${result.value.dropped} events`);
    }
    await updateSync({ lastSyncAt: now() });
  });
  if (result.ok && batch.length === FLUSH_BATCH) return flushEvents();
}

// The server rejects a capture whose page view it has not seen, for good. A
// page view is queued before its captures, so an empty events outbox means it
// has been delivered or dropped.
export async function uploadCaptures(): Promise<void> {
  if ((await pendingCounts()).events > 0) return;
  const head = await nextDueCapture();
  if (!head) return;
  const settings = await loadSettings();
  const result = await postCapture(settings.serverUrl, head.payload);
  await serialized(async () => {
    if (!result.ok) {
      if (isPermanentFailure(result.status)) {
        await removeRows("captures", [head.id]);
        await countDropped(1);
        await diag(`capture dropped ${head.payload.meta.extractor}: ${result.error}`);
      } else {
        await markFailed("captures", [head]);
        await diag(`capture upload failed: ${result.error}`);
      }
      await updateSync({ lastError: result.error });
      return;
    }
    await removeRows("captures", [head.id]);
    await updateSync({ lastSyncAt: now() });
    await diag(
      `capture uploaded ${head.payload.meta.extractor}${result.value.deduplicated ? " (dedup)" : ""}`,
    );
  });
  if (result.ok) return uploadCaptures();
}

type FocusTarget = { tabId: number; pageView: PageViewState };

async function focusedTarget(at: number): Promise<FocusTarget | undefined> {
  const focusedWindow = await browser.windows.getLastFocused().catch(() => undefined);
  if (!focusedWindow?.focused || focusedWindow.id === undefined) return undefined;
  const [tab] = await browser.tabs.query({ active: true, windowId: focusedWindow.id });
  if (tab?.id === undefined) return undefined;
  if ((await browser.idle.queryState(IDLE_SECONDS)) !== "active") return undefined;
  const state = await tabStore(tab.id).get();
  const pageView = state ? state.pageView : await adoptTab(tab.id, tab, at);
  return pageView ? { tabId: tab.id, pageView } : undefined;
}

// The stale check comes first because a worker that survives a sleep sees
// the wake before any idle or lock event: without it, the span would run
// through the night.
export async function reconcile(reason: EndReason, at: number, endedAt = at): Promise<void> {
  await closeStaleSpan(STALE_SPAN_MS);
  const target = isPaused(await loadSettings(), at) ? undefined : await focusedTarget(at);
  const open = await openSpanStore.get();
  if (open && target && open.pageViewId === target.pageView.event.id) return;
  if (open) await closeSpan(open, reason, iso(Math.max(endedAt, Date.parse(open.startedAt))));
  if (target) await startSpan(target, at);
}

// chrome.idle reports idle a full detection interval after the last input,
// which is when attention actually stopped; locking the screen is an input.
export async function onIdleStateChanged(
  state: `${Browser.idle.IdleState}`,
  at: number,
): Promise<void> {
  await reconcile("idle", at, state === "idle" ? at - IDLE_SECONDS * 1000 : at);
}

async function closeSpan(open: OpenSpan, reason: EndReason, endedAt: string): Promise<void> {
  await browser.alarms.clear(captureAlarm(open.tabId, open.pageViewId));
  await sendLatestTitle(open.tabId, open.pageViewId);
  await openSpanStore.remove();
  await emit({ type: "span_end", id: open.id, ended_at: endedAt, reason });
  await diag(`span closed (${reason})`);
  void serialized(() => recaptureIfDue(open));
}

// A thread or a pull request keeps changing while it is read, so its page is
// captured again on the span's heartbeats and when the span ends. Both are
// needed: a span ended by navigation finds the tab already on the next page.
async function recaptureIfDue({ tabId, pageViewId }: OpenSpan): Promise<void> {
  const pageView = (await tabStore(tabId).get())?.pageView;
  if (pageView?.event.id !== pageViewId || pageView.lastCapturedAt === undefined) return;
  if (Date.now() - Date.parse(pageView.lastCapturedAt) < RECAPTURE_INTERVAL_MS) return;
  if (ruleFor(await cachedRules(), pageView.event.url)?.recapture !== "after_change") return;
  const outcome = await captureTab(tabId, "recapture");
  if (!outcome.ok) await diag(`recapture skipped: ${outcome.error}`);
}

async function startSpan(target: FocusTarget, at: number): Promise<void> {
  const startedAt = iso(at);
  const span: OpenSpan = {
    id: uuidv7(),
    pageViewId: target.pageView.event.id,
    tabId: target.tabId,
    startedAt,
    lastHeartbeatAt: startedAt,
  };
  await openSpanStore.set(span);
  await emit({
    type: "span_start",
    id: span.id,
    page_view_id: span.pageViewId,
    started_at: startedAt,
  });
  await diag(`span open ${target.pageView.event.url}`);
  await armCapture();
}

async function armCapture(): Promise<void> {
  const open = await openSpanStore.get();
  if (!open) return;
  const pageView = (await tabStore(open.tabId).get())?.pageView;
  if (!pageView || pageView.event.id !== open.pageViewId) return;
  if (pageView.lastCapturedAt !== undefined || pageView.event.private) return;
  const settings = await loadSettings();
  if (!settings.captureEnabled) return;
  const rule = ruleFor(await cachedRules(), pageView.event.url);
  if (!rule) return;
  await browser.alarms.create(captureAlarm(open.tabId, open.pageViewId), {
    when: Date.now() + rule.dwell_ms,
  });
}

async function heartbeat(at: number): Promise<void> {
  const { pausedUntil } = await loadSettings();
  if (pausedUntil !== undefined && pausedUntil <= at) await endPause();
  await reconcile("unknown", at);
  const open = await openSpanStore.get();
  if (!open) return;
  const lastHeartbeatAt = iso(at);
  await openSpanStore.set({ ...open, lastHeartbeatAt });
  await emit({ type: "span_heartbeat", id: open.id, at: lastHeartbeatAt });
  await sendLatestTitle(open.tabId, open.pageViewId);
  void serialized(() => recaptureIfDue(open));
}

async function closeStaleSpan(maxAgeMs: number): Promise<void> {
  const open = await openSpanStore.get();
  if (!open) return;
  if (Date.now() - Date.parse(open.lastHeartbeatAt) > maxAgeMs) {
    await closeSpan(open, "unknown", open.lastHeartbeatAt);
  }
}

// No reconcile here: the event that woke the worker is queued right behind
// this and closes the span with its own reason, and the heartbeat alarm
// reconciles within 30 s when nothing else does.
export async function onWorkerStart(): Promise<void> {
  await ensureAlarms();
  await closeStaleSpan(STALE_SPAN_MS);
  if (isPaused(await loadSettings(), Date.now()))
    await browser.action.setBadgeText({ text: "off" });
  void requestSync((await rulesStore.get()) ? ["health"] : ["rules", "health"]);
}

export async function onInstalled(): Promise<void> {
  await deviceId();
  await diag("installed");
  void requestSync(["rules"]);
}

export async function onBrowserStartup(): Promise<void> {
  await closeStaleSpan(0);
  void requestSync(["rules"]);
}

export async function onCommitted(
  details: Browser.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  await beginPageView(
    details.tabId,
    details.url,
    navigationTypeFor(details.transitionType, details.transitionQualifiers),
    details.timeStamp,
  );
}

export async function onHistoryStateUpdated(
  details: Browser.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  await onSpaChange(
    details.tabId,
    details.url,
    spaNavigationType(details.transitionQualifiers),
    details.timeStamp,
  );
}

async function onSpaChange(
  tabId: number,
  url: string,
  navigationType: "spa" | "back_forward",
  at: number,
): Promise<void> {
  const current = (await tabStore(tabId).get())?.pageView;
  if (current) {
    const parsed = URL.parse(url);
    const settings = await loadSettings();
    const next =
      parsed && isPrivateHost(parsed.hostname, settings.privateHosts) ? privateUrl(parsed) : url;
    const rule = parsed ? matchRule(await cachedRules(), parsed) : undefined;
    if (!isNewPageView(current.event.url, next, rule)) return;
  }
  await beginPageView(tabId, url, navigationType, at);
}

async function beginPageView(
  tabId: number,
  url: string,
  navigationType: PageViewEvent["navigation_type"],
  at: number,
): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.incognito) return;
  await recordPageView(tabId, tab, url, navigationType, at);
  await reconcile("navigation", at);
}

// A tab open before the extension loaded has no state and would go
// unrecorded until it navigates; the first time it takes focus it is
// recorded as of then.
async function adoptTab(
  tabId: number,
  tab: Browser.tabs.Tab,
  at: number,
): Promise<PageViewState | undefined> {
  if (tab.incognito || tab.url === undefined) return undefined;
  await recordPageView(tabId, tab, tab.url, "load", at);
  return (await tabStore(tabId).get())?.pageView;
}

async function recordPageView(
  tabId: number,
  tab: Browser.tabs.Tab,
  url: string,
  navigationType: PageViewEvent["navigation_type"],
  at: number,
): Promise<void> {
  await sendLatestTitle(tabId);
  await clearSeenBefore(tabId);
  const store = tabStore(tabId);
  const settings = await loadSettings();
  // Without state the tab is adopted when it next takes focus, which after
  // the pause records the page it is on as of then.
  if (isPaused(settings, at)) {
    await store.remove();
    return;
  }
  const previous = await store.get();
  const tabSessionId = previous?.tabSessionId ?? uuidv7();
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    await store.set({ tabSessionId });
    return;
  }
  const isPrivate = isPrivateHost(parsed.hostname, settings.privateHosts);
  const event: PageViewEvent = {
    type: "page_view",
    id: uuidv7(),
    url: isPrivate ? privateUrl(parsed) : parsed.href,
    started_at: iso(at),
    navigation_type: navigationType,
    tab_session_id: tabSessionId,
    private: isPrivate,
  };
  const referrer = previous?.pageView && URL.parse(previous.pageView.event.url);
  if (referrer) {
    event.referrer = isPrivateHost(referrer.hostname, settings.privateHosts)
      ? privateUrl(referrer)
      : referrer.href;
  }
  // By the time this runs the tab may already show another document, such as
  // a redirect target on a private host; its title is not this page's.
  if (!isPrivate && tab.title && tab.url === url) event.title = tab.title;
  await store.set({ tabSessionId, pageView: { event, titled: false } });
  await emit(event);
  await diag(`page view ${event.url} (${navigationType})`);
  void showSeenBefore(tabId, event);
}

async function clearSeenBefore(tabId: number): Promise<void> {
  await browser.action.setBadgeText({ tabId });
  await browser.action.setTitle({ tabId, title: "" });
}

// The lookup runs outside the queue; by the time it answers, the tab may
// have moved on to another page view, whose badge this is not.
export async function showSeenBefore(tabId: number, event: PageViewEvent): Promise<void> {
  if (event.private) return;
  const result = await fetchVisits((await loadSettings()).serverUrl, event.url, event.started_at);
  if (!result.ok) return;
  const seen = describeVisits("Seen", result.value, Date.now());
  if (seen === undefined) return;
  await serialized(async () => {
    if ((await tabStore(tabId).get())?.pageView?.event.id !== event.id) return;
    if (isPaused(await loadSettings(), Date.now())) return;
    await browser.action.setBadgeText({ tabId, text: String(result.value.count) });
    await browser.action.setTitle({ tabId, title: seen });
  });
}

async function isPrivateNow(event: PageViewEvent): Promise<boolean> {
  const host = URL.parse(event.url)?.hostname;
  return (
    event.private || host === undefined || isPrivateHost(host, (await loadSettings()).privateHosts)
  );
}

// The first change goes out at once, because a background tab may never get a
// span. Later ones wait for the span's heartbeat or the end of the page view,
// so a page that counts or ticks in its title sends at most one update per
// heartbeat, and a title that settles after "Loading…" still arrives.
export async function onTitleChanged(tabId: number, title: string, at: number): Promise<void> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView || (await isPrivateNow(pageView.event))) return;
  if (isPaused(await loadSettings(), at)) return;
  await store.set({ ...state, pageView: { ...pageView, latestTitle: title } });
  if (!pageView.titled) await sendLatestTitle(tabId);
}

async function sendLatestTitle(tabId: number, pageViewId?: string): Promise<void> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView || (pageViewId !== undefined && pageView.event.id !== pageViewId)) return;
  const title = pageView.latestTitle;
  if (title === undefined || title === pageView.event.title) return;
  if (await isPrivateNow(pageView.event)) return;
  const event = { ...pageView.event, title };
  await store.set({ ...state, pageView: { ...pageView, event, titled: true } });
  await emit(event);
}

export async function onTabRemoved(tabId: number, at: number): Promise<void> {
  await closeStaleSpan(STALE_SPAN_MS);
  const open = await openSpanStore.get();
  if (open?.tabId === tabId) await closeSpan(open, "tab_closed", iso(at));
  await sendLatestTitle(tabId);
  await tabStore(tabId).remove();
  await reconcile("tab_closed", at);
}

export async function onAlarm(alarm: Browser.alarms.Alarm, at: number): Promise<void> {
  if (alarm.name === HEARTBEAT_ALARM) {
    await heartbeat(at);
    void requestSync(["health"]);
    return;
  }
  if (alarm.name === RULES_ALARM) {
    void requestSync(["rules"]);
    return;
  }
  if (alarm.name.startsWith(CAPTURE_ALARM_PREFIX)) await onCaptureAlarm(alarm.name);
}

async function onCaptureAlarm(name: string): Promise<void> {
  const [tabId, pageViewId] = name.slice(CAPTURE_ALARM_PREFIX.length).split(":");
  const open = await openSpanStore.get();
  if (!tabId || !pageViewId || open?.pageViewId !== pageViewId) return;
  const outcome = await captureTab(Number(tabId), "initial");
  if (!outcome.ok) await diag(`capture skipped: ${outcome.error}`);
}

// Every handler waits in one queue, and a tab whose main thread is stuck in
// an alert or a huge diff would otherwise hold it for as long as it stays so.
const SERIALIZE_TIMEOUT_MS = 10_000;

async function requestHtml(tabId: number): Promise<Result<SerializeReply>> {
  const request: SerializeRequest = { type: "serialize" };
  try {
    const reply = await Promise.race([
      browser.tabs.sendMessage<SerializeRequest, unknown>(tabId, request),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("no reply in time")), SERIALIZE_TIMEOUT_MS);
      }),
    ]);
    const decoded = SerializeReply(reply);
    return decoded instanceof type.errors
      ? { ok: false, error: `content script replied badly: ${decoded.summary}` }
      : { ok: true, value: decoded };
  } catch (error) {
    return { ok: false, error: `content script unreachable: ${errorMessage(error)}` };
  }
}

export async function captureTab(tabId: number, reason: CaptureReason): Promise<ActionReply> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView) return failure("no page view for this tab");
  if (pageView.event.private) return failure("private host");
  const settings = await loadSettings();
  if (isPaused(settings, Date.now())) return failure("tracking is paused");
  const pageURL = URL.parse(pageView.event.url);
  if (!pageURL) return failure("invalid page URL");
  if (isPrivateHost(pageURL.hostname, settings.privateHosts)) return failure("private host");
  if (!settings.captureEnabled) return failure("capture is disabled in options");
  const rule = ruleFor(await cachedRules(), pageView.event.url);
  if (!rule) return failure("no capture rule matches this page");
  const page = await requestHtml(tabId);
  if (!page.ok) return page;
  const { html, title, url, dirty } = page.value;
  const capturedURL = URL.parse(url);
  const latestSettings = await loadSettings();
  if (!latestSettings.captureEnabled) return failure("capture is disabled in options");
  if (capturedURL && isPrivateHost(capturedURL.hostname, latestSettings.privateHosts)) {
    return failure("private host");
  }
  if (!capturedURL || isNewPageView(pageView.event.url, url, rule)) {
    return failure("page changed during capture");
  }
  if (reason === "recapture" && !dirty) return failure("page unchanged since last capture");
  const bytes = new Blob([html]).size;
  if (bytes > rule.max_bytes) {
    return failure(`page is ${bytes} bytes, ${rule.extractor} allows ${rule.max_bytes}`);
  }
  const meta: CaptureMeta = {
    capture_id: uuidv7(),
    page_view_id: pageView.event.id,
    device_id: await deviceId(),
    captured_at: now(),
    url,
    extractor: rule.extractor,
    reason,
    raw_char_count: html.length,
  };
  if (title) meta.title = title;
  await reportEvicted("captures", await enqueueCapture({ meta, html }));
  await store.set({ ...state, pageView: { ...pageView, lastCapturedAt: meta.captured_at } });
  await diag(`capture queued ${rule.extractor} ${reason} ${bytes} bytes${dirty ? " (dirty)" : ""}`);
  void requestSync();
  return { ok: true };
}

async function captureActiveTab(): Promise<ActionReply> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return failure("no active tab");
  return captureTab(tab.id, "manual");
}

async function status(): Promise<StatusReply> {
  const [counts, sync, lines, auth, settings] = await Promise.all([
    pendingCounts(),
    syncStore.get(),
    diagnostics(),
    authState(),
    loadSettings(),
  ]);
  return {
    connected: sync?.connected ?? false,
    auth,
    pendingEvents: counts.events,
    pendingCaptures: counts.captures,
    lastSyncAt: sync?.lastSyncAt,
    lastError: sync?.lastError,
    dropped: sync?.dropped ?? 0,
    diagnostics: lines,
    pausedUntil: isPaused(settings, Date.now()) ? settings.pausedUntil : undefined,
  };
}

// Pausing ends the open span now, with its own reason; the span would
// otherwise only close at the next event or heartbeat.
async function pause(at: number): Promise<ActionReply> {
  const open = await openSpanStore.get();
  if (open) await closeSpan(open, "paused", iso(at));
  await settingsStore.set({ ...(await loadSettings()), pausedUntil: at + PAUSE_MS });
  const tabs = await browser.tabs.query({});
  await Promise.all(tabs.flatMap(({ id }) => (id === undefined ? [] : [clearSeenBefore(id)])));
  await browser.action.setBadgeText({ text: "off" });
  await diag(`paused until ${iso(at + PAUSE_MS)}`);
  return { ok: true };
}

async function endPause(): Promise<void> {
  const { pausedUntil, ...settings } = await loadSettings();
  if (pausedUntil === undefined) return;
  await settingsStore.set(settings);
  await browser.action.setBadgeText({ text: "" });
  await diag("resumed");
}

type WebPage = { tabId: number; url: URL };

async function activeWebPage(): Promise<WebPage | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url === undefined ? undefined : URL.parse(tab.url);
  if (tab?.id === undefined || !url) return undefined;
  return url.protocol === "http:" || url.protocol === "https:" ? { tabId: tab.id, url } : undefined;
}

// The tab's page view so far carries its full URL. Starting a new one now
// means the time spent from here on counts towards a host-only page view.
async function makeActiveHostPrivate(at: number): Promise<ActionReply> {
  const page = await activeWebPage();
  if (!page) return failure("no web page in the active tab");
  const settings = await loadSettings();
  const host = page.url.hostname;
  if (!isPrivateHost(host, settings.privateHosts)) {
    await settingsStore.set({ ...settings, privateHosts: [...settings.privateHosts, host] });
    await diag(`private host added: ${host}`);
  }
  if ((await tabStore(page.tabId).get())?.pageView?.event.private !== true) {
    await beginPageView(page.tabId, page.url.href, "load", at);
  }
  return { ok: true };
}

export async function forget(scope: ForgetScope): Promise<ForgetReply> {
  const target = await serialized(() => forgetLocally(scope));
  if (!target) return failure("forgetting failed, see the log");
  if (!target.ok) return target;
  // A sync already running may carry rows just dropped here; the server has to
  // store them before it deletes them, or they would outlive the forget.
  await syncing;
  const result = await postForget((await loadSettings()).serverUrl, target.value);
  await serialized(() =>
    diag(result.ok ? `server forgot ${JSON.stringify(result.value)}` : `forget: ${result.error}`),
  );
  return result.ok ? { ok: true, forgotten: result.value } : failure(result.error);
}

// The page view's URL rather than the tab's: an SPA may have changed query
// keys since, and a private host's page views carry only the host.
async function recordedUrl({ tabId, url }: WebPage): Promise<string> {
  const recorded = (await tabStore(tabId).get())?.pageView?.event.url;
  if (recorded !== undefined) return recorded;
  return isPrivateHost(url.hostname, (await loadSettings()).privateHosts)
    ? privateUrl(url)
    : url.href;
}

// A tab on a forgotten page keeps no page view, so nothing more is recorded
// for it until it navigates.
async function forgetLocally(scope: ForgetScope): Promise<Result<ForgetTarget>> {
  const page = await activeWebPage();
  if (!page) return failure("no web page in the active tab");
  const target: ForgetTarget =
    scope === "host" ? { host: page.url.hostname } : { url: await recordedUrl(page) };
  const forgotten = forgets(target);
  const tabs = await browser.tabs.query({});
  const forgottenInTabs = await Promise.all(
    tabs.flatMap(({ id }) => (id === undefined ? [] : [forgetInTab(id, forgotten)])),
  );
  const ids = new Set(forgottenInTabs.filter((id) => id !== undefined));
  const open = await openSpanStore.get();
  if (open && ids.has(open.pageViewId)) {
    await browser.alarms.clear(captureAlarm(open.tabId, open.pageViewId));
    await openSpanStore.remove();
    ids.add(open.id);
  }
  const dropped = await purge(forgotten, ids);
  await diag(
    `forgetting a ${scope}: dropped ${dropped.events} queued events, ${dropped.captures} captures`,
  );
  return { ok: true, value: target };
}

async function forgetInTab(
  tabId: number,
  forgotten: (url: string) => boolean,
): Promise<string | undefined> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView) return undefined;
  if (forgotten(pageView.event.url)) {
    await store.set({ tabSessionId: state.tabSessionId });
    await clearSeenBefore(tabId);
    return pageView.event.id;
  }
  const { referrer, ...event } = pageView.event;
  if (referrer !== undefined && forgotten(referrer)) {
    await store.set({ ...state, pageView: { ...pageView, event } });
  }
  return undefined;
}

export async function handleMessage(
  message: Exclude<BackgroundMessage, ForgetMessage>,
  sender: Browser.runtime.MessageSender,
  at: number,
): Promise<StatusReply | ActionReply | undefined> {
  if (message.type === "status") return status();
  if (message.type === "capture_now") return captureActiveTab();
  if (message.type === "pause") return pause(at);
  if (message.type === "make_private") return makeActiveHostPrivate(at);
  if (message.type === "resume") {
    await endPause();
    await reconcile("unknown", at);
    return { ok: true };
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return undefined;
  await onSpaChange(tabId, message.url, message.navigation_type, at);
  return undefined;
}
