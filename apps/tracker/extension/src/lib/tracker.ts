import { type } from "arktype";
import { browser, type Browser } from "wxt/browser";

import { checkHealth, fetchRules, postCapture, postEvents, type Result } from "./api.ts";
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
  type BackgroundMessage,
  type CaptureNowReply,
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
  removeRows,
} from "./outbox.ts";
import { isNewPageView, navigationTypeFor, spaNavigationType } from "./page-view.ts";
import { isPrivateHost, privateUrl } from "./privacy.ts";
import { recaptureDecision } from "./recapture.ts";
import { isPermanentFailure } from "./result.ts";
import { matchRule, type Rule } from "./rules.ts";
import {
  countDropped,
  deviceIdStore,
  diag,
  diagnostics,
  loadSettings,
  openSpanStore,
  rulesStore,
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
const RECAPTURE_ALARM_PREFIX = "recapture:";
export const IDLE_SECONDS = 60;
const FLUSH_DELAY_MS = 10_000;
const FLUSH_BATCH = 100;
const STALE_SPAN_MS = 90_000;

const now = () => new Date().toISOString();
const failure = (error: string): CaptureNowReply => ({ ok: false, error });
const captureAlarm = (tabId: number, pageViewId: string) =>
  `${CAPTURE_ALARM_PREFIX}${tabId}:${pageViewId}`;
const recaptureAlarm = (tabId: number, pageViewId: string) =>
  `${RECAPTURE_ALARM_PREFIX}${tabId}:${pageViewId}`;

async function clearRecaptureAlarms(tabId: number): Promise<void> {
  const prefix = `${RECAPTURE_ALARM_PREFIX}${tabId}:`;
  const alarms = await browser.alarms.getAll();
  await Promise.all(
    alarms
      .filter((alarm) => alarm.name.startsWith(prefix))
      .map((alarm) => browser.alarms.clear(alarm.name)),
  );
}

let chain: Promise<void> = Promise.resolve();

// Every handler runs through one queue so storage read-modify-write cycles never interleave.
export function serialized<T>(task: () => Promise<T>): Promise<T | undefined> {
  const run = chain.then(async () => {
    try {
      return await task();
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

export async function refreshRules(): Promise<void> {
  const settings = await loadSettings();
  const result = await fetchRules(settings.serverUrl);
  if (!result.ok) {
    await updateSync({ lastError: result.error });
    await diag(`rules: ${result.error}`);
    return;
  }
  await rulesStore.set({ fetchedAt: now(), rules: result.value });
  await diag(`rules: ${result.value.length} cached`);
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
  const before = (await syncStore.get())?.connected ?? false;
  const result = await checkHealth(settings.serverUrl);
  const connected = result.ok && result.value.ok;
  if (connected) await updateSync({ connected });
  else
    await updateSync({ connected, lastError: result.ok ? "healthz reports not ok" : result.error });
  if (connected && !before) {
    await diag("server reachable");
    await armCapture();
  }
  if (!connected && before) await diag("server unreachable, capture paused");
}

let flushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    void serialized(flushEvents);
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
  if (events >= FLUSH_BATCH) await flushEvents();
  else scheduleFlush();
}

export async function flushEvents(): Promise<void> {
  const batch = await dueEvents(FLUSH_BATCH);
  if (batch.length === 0) return;
  const settings = await loadSettings();
  const result = await postEvents(
    settings.serverUrl,
    await deviceId(),
    batch.map((row) => row.payload),
  );
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
  if (batch.length === FLUSH_BATCH) return flushEvents();
}

export async function uploadCaptures(): Promise<void> {
  const head = await nextDueCapture();
  if (!head) return;
  const settings = await loadSettings();
  const result = await postCapture(settings.serverUrl, head.payload);
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
  return uploadCaptures();
}

type FocusTarget = { tabId: number; pageView: PageViewState };

async function focusedTarget(): Promise<FocusTarget | undefined> {
  const focusedWindow = await browser.windows.getLastFocused().catch(() => undefined);
  if (!focusedWindow?.focused || focusedWindow.id === undefined) return undefined;
  const [tab] = await browser.tabs.query({ active: true, windowId: focusedWindow.id });
  if (tab?.id === undefined) return undefined;
  if ((await browser.idle.queryState(IDLE_SECONDS)) !== "active") return undefined;
  const state = await tabStore(tab.id).get();
  const pageView = state ? state.pageView : await adoptTab(tab.id, tab);
  return pageView ? { tabId: tab.id, pageView } : undefined;
}

// The stale check comes first because a worker that survives a sleep sees
// the wake before any idle or lock event: without it, the span would run
// through the night.
export async function reconcile(reason: EndReason, endedAt = now()): Promise<void> {
  await closeStaleSpan(STALE_SPAN_MS);
  const target = await focusedTarget();
  const open = await openSpanStore.get();
  if (open && target && open.pageViewId === target.pageView.event.id) return;
  if (open) await closeSpan(open, reason, endedAt > open.startedAt ? endedAt : open.startedAt);
  if (target) await startSpan(target);
}

// chrome.idle reports idle a full detection interval after the last input,
// which is when attention actually stopped; locking the screen is an input.
export async function onIdleStateChanged(state: `${Browser.idle.IdleState}`): Promise<void> {
  const endedAt =
    state === "idle" ? new Date(Date.now() - IDLE_SECONDS * 1000).toISOString() : now();
  await reconcile("idle", endedAt);
}

async function closeSpan(open: OpenSpan, reason: EndReason, endedAt: string): Promise<void> {
  await browser.alarms.clear(captureAlarm(open.tabId, open.pageViewId));
  await openSpanStore.remove();
  await emit({ type: "span_end", id: open.id, ended_at: endedAt, reason });
  await diag(`span closed (${reason})`);
}

async function startSpan(target: FocusTarget): Promise<void> {
  const startedAt = now();
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
  if (!(await syncStore.get())?.connected) return;
  const rule = ruleFor(await cachedRules(), pageView.event.url);
  if (!rule) return;
  await browser.alarms.create(captureAlarm(open.tabId, open.pageViewId), {
    when: Date.now() + rule.dwell_ms,
  });
}

async function heartbeat(): Promise<void> {
  await reconcile("unknown");
  const open = await openSpanStore.get();
  if (!open) return;
  const at = now();
  await openSpanStore.set({ ...open, lastHeartbeatAt: at });
  await emit({ type: "span_heartbeat", id: open.id, at });
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
  if (!(await rulesStore.get())) await refreshRules();
  await pollHealth();
  await flushEvents();
  await uploadCaptures();
}

export async function onInstalled(): Promise<void> {
  await deviceId();
  await diag("installed");
  await refreshRules();
}

export async function onBrowserStartup(): Promise<void> {
  await closeStaleSpan(0);
  await refreshRules();
}

export async function onConfigChanged(): Promise<void> {
  await refreshRules();
  await pollHealth();
}

export async function onCommitted(
  details: Browser.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  await beginPageView(
    details.tabId,
    details.url,
    navigationTypeFor(details.transitionType, details.transitionQualifiers),
  );
}

export async function onHistoryStateUpdated(
  details: Browser.webNavigation.WebNavigationTransitionCallbackDetails,
): Promise<void> {
  await onSpaChange(details.tabId, details.url, spaNavigationType(details.transitionQualifiers));
}

async function onSpaChange(
  tabId: number,
  url: string,
  navigationType: "spa" | "back_forward",
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
  await beginPageView(tabId, url, navigationType);
}

async function beginPageView(
  tabId: number,
  url: string,
  navigationType: PageViewEvent["navigation_type"],
): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab || tab.incognito) return;
  await recordPageView(tabId, tab, url, navigationType);
  await reconcile("navigation");
}

// A tab open before the extension loaded has no state and would go
// unrecorded until it navigates; the first time it takes focus it is
// recorded as of then.
async function adoptTab(tabId: number, tab: Browser.tabs.Tab): Promise<PageViewState | undefined> {
  if (tab.incognito || tab.url === undefined) return undefined;
  await recordPageView(tabId, tab, tab.url, "load");
  return (await tabStore(tabId).get())?.pageView;
}

async function recordPageView(
  tabId: number,
  tab: Browser.tabs.Tab,
  url: string,
  navigationType: PageViewEvent["navigation_type"],
): Promise<void> {
  await clearRecaptureAlarms(tabId);
  const store = tabStore(tabId);
  const previous = await store.get();
  const tabSessionId = previous?.tabSessionId ?? uuidv7();
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    await store.set({ tabSessionId });
    return;
  }
  const settings = await loadSettings();
  const isPrivate = isPrivateHost(parsed.hostname, settings.privateHosts);
  const event: PageViewEvent = {
    type: "page_view",
    id: uuidv7(),
    url: isPrivate ? privateUrl(parsed) : parsed.href,
    started_at: now(),
    navigation_type: navigationType,
    tab_session_id: tabSessionId,
    private: isPrivate,
  };
  if (previous?.pageView) event.referrer = previous.pageView.event.url;
  // By the time this runs the tab may already show another document, such as
  // a redirect target on a private host; its title is not this page's.
  if (!isPrivate && tab.title && tab.url === url) event.title = tab.title;
  await store.set({ tabSessionId, pageView: { event, titled: false } });
  await emit(event);
  await diag(`page view ${event.url} (${navigationType})`);
}

export async function onTitleChanged(tabId: number, title: string): Promise<void> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView || pageView.titled || pageView.event.private) return;
  if (pageView.event.title === title) return;
  const event = { ...pageView.event, title };
  await store.set({ ...state, pageView: { ...pageView, event, titled: true } });
  await emit(event);
}

export async function onTabRemoved(tabId: number): Promise<void> {
  await closeStaleSpan(STALE_SPAN_MS);
  const open = await openSpanStore.get();
  if (open?.tabId === tabId) await closeSpan(open, "tab_closed", now());
  await clearRecaptureAlarms(tabId);
  await tabStore(tabId).remove();
  await reconcile("tab_closed");
}

export async function onAlarm(alarm: Browser.alarms.Alarm): Promise<void> {
  if (alarm.name === HEARTBEAT_ALARM) {
    await heartbeat();
    await pollHealth();
    await flushEvents();
    await uploadCaptures();
    return;
  }
  if (alarm.name === RULES_ALARM) {
    await refreshRules();
    return;
  }
  if (alarm.name.startsWith(RECAPTURE_ALARM_PREFIX)) await onRecaptureAlarm(alarm.name);
  else if (alarm.name.startsWith(CAPTURE_ALARM_PREFIX)) await onCaptureAlarm(alarm.name);
}

async function onCaptureAlarm(name: string): Promise<void> {
  const [tabId, pageViewId] = name.slice(CAPTURE_ALARM_PREFIX.length).split(":");
  const open = await openSpanStore.get();
  if (!tabId || !pageViewId || open?.pageViewId !== pageViewId) return;
  const outcome = await captureTab(Number(tabId), "initial");
  if (!outcome.ok) await diag(`capture skipped: ${outcome.error}`);
}

async function onQuiet(tabId: number): Promise<void> {
  const pageView = (await tabStore(tabId).get())?.pageView;
  if (!pageView) return;
  const rule = ruleFor(await cachedRules(), pageView.event.url);
  const decision = recaptureDecision({
    rule,
    lastCapturedAt: pageView.lastCapturedAt,
    now: Date.now(),
  });
  if (decision.kind === "never") return;
  if (decision.kind === "defer") {
    await clearRecaptureAlarms(tabId);
    await browser.alarms.create(recaptureAlarm(tabId, pageView.event.id), { when: decision.due });
    return;
  }
  await recapture(tabId, pageView.event.id);
}

async function recapture(tabId: number, pageViewId: string): Promise<void> {
  await clearRecaptureAlarms(tabId);
  const outcome = await captureTab(tabId, "recapture");
  if (!outcome.ok) await diag(`recapture skipped ${pageViewId}: ${outcome.error}`);
}

async function onRecaptureAlarm(name: string): Promise<void> {
  const [tabId, pageViewId] = name.slice(RECAPTURE_ALARM_PREFIX.length).split(":");
  if (!tabId || !pageViewId) return;
  const pageView = (await tabStore(Number(tabId)).get())?.pageView;
  if (pageView?.event.id !== pageViewId) return;
  await recapture(Number(tabId), pageViewId);
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

export async function captureTab(tabId: number, reason: CaptureReason): Promise<CaptureNowReply> {
  const store = tabStore(tabId);
  const state = await store.get();
  const pageView = state?.pageView;
  if (!state || !pageView) return failure("no page view for this tab");
  if (pageView.event.private) return failure("private host");
  const settings = await loadSettings();
  const pageURL = URL.parse(pageView.event.url);
  if (!pageURL) return failure("invalid page URL");
  if (isPrivateHost(pageURL.hostname, settings.privateHosts)) return failure("private host");
  if (!settings.captureEnabled) return failure("capture is disabled in options");
  if (!(await syncStore.get())?.connected) return failure("server unreachable, capture paused");
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
  // The capture references its page view, which may still be waiting for the
  // flush timer; the server rejects the one without the other.
  await flushEvents();
  await uploadCaptures();
  return { ok: true };
}

async function captureActiveTab(): Promise<CaptureNowReply> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return failure("no active tab");
  return captureTab(tab.id, "manual");
}

async function status(): Promise<StatusReply> {
  const [counts, sync, lines, auth] = await Promise.all([
    pendingCounts(),
    syncStore.get(),
    diagnostics(),
    authState(),
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
  };
}

export async function handleMessage(
  message: BackgroundMessage,
  sender: Browser.runtime.MessageSender,
): Promise<StatusReply | CaptureNowReply | undefined> {
  if (message.type === "status") return status();
  if (message.type === "capture_now") return captureActiveTab();
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return undefined;
  if (message.type === "quiet") await onQuiet(tabId);
  else await onSpaChange(tabId, message.url, message.navigation_type);
  return undefined;
}
