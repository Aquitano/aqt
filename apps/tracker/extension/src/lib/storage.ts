import { type Type, type } from "arktype";
import { browser, type Browser } from "wxt/browser";

import { PageViewEvent } from "./events.ts";
import { Rule } from "./rules.ts";
import { Settings, defaultSettings } from "./settings.ts";

const DIAGNOSTIC_LINES = 100;

function keyed<t>(area: Browser.storage.StorageArea, key: string, schema: Type<t>) {
  return {
    async get(): Promise<Type<t>["infer"] | undefined> {
      const found = await area.get(key);
      const decoded = schema(found[key]);
      return decoded instanceof type.errors ? undefined : decoded;
    },
    async set(value: Type<t>["infer"]): Promise<void> {
      await area.set({ [key]: value });
    },
    async remove(): Promise<void> {
      await area.remove(key);
    },
  };
}

export const deviceIdStore = keyed(browser.storage.local, "deviceId", type("string"));

export const AuthTokens = type({
  accessToken: "string",
  expiresAt: "number",
  "refreshToken?": "string",
});
export type AuthTokens = typeof AuthTokens.infer;
export const authTokensStore = keyed(browser.storage.local, "authTokens", AuthTokens);
export const settingsStore = keyed(browser.storage.local, "settings", Settings);

export const RulesCache = type({ fetchedAt: "string", rules: Rule.array() });
export const rulesStore = keyed(browser.storage.local, "rules", RulesCache);

export const OpenSpan = type({
  id: "string",
  pageViewId: "string",
  tabId: "number",
  startedAt: "string",
  lastHeartbeatAt: "string",
});
export type OpenSpan = typeof OpenSpan.infer;
export const openSpanStore = keyed(browser.storage.local, "openSpan", OpenSpan);

export const SyncState = type({
  connected: "boolean",
  "lastSyncAt?": "string",
  "lastError?": "string",
  "dropped?": "number",
});
export type SyncState = typeof SyncState.infer;
export const syncStore = keyed(browser.storage.local, "sync", SyncState);

const diagnosticsStore = keyed(browser.storage.local, "diagnostics", type("string[]"));

export const PageViewState = type({
  event: PageViewEvent,
  titled: "boolean",
  "latestTitle?": "string",
  "lastCapturedAt?": "string",
});
export type PageViewState = typeof PageViewState.infer;
export const TabState = type({ tabSessionId: "string", "pageView?": PageViewState });
export const tabStore = (tabId: number) => keyed(browser.storage.session, `tab:${tabId}`, TabState);

export async function loadSettings(): Promise<Settings> {
  return (await settingsStore.get()) ?? defaultSettings;
}

export async function updateSync(patch: Partial<SyncState>): Promise<void> {
  const current = (await syncStore.get()) ?? { connected: false };
  await syncStore.set({ ...current, ...patch });
}

export async function countDropped(count: number): Promise<void> {
  const current = (await syncStore.get()) ?? { connected: false };
  await syncStore.set({ ...current, dropped: (current.dropped ?? 0) + count });
}

export async function diag(line: string): Promise<void> {
  const lines = (await diagnosticsStore.get()) ?? [];
  lines.push(`${new Date().toISOString()} ${line}`);
  await diagnosticsStore.set(lines.slice(-DIAGNOSTIC_LINES));
}

export async function diagnostics(): Promise<string[]> {
  return (await diagnosticsStore.get()) ?? [];
}
