import { type } from "arktype";

export const Settings = type({
  serverUrl: "string",
  privateHosts: "string[]",
  captureEnabled: "boolean",
});
export type Settings = typeof Settings.infer;

export const defaultSettings: Settings = {
  serverUrl: "http://127.0.0.1:8490",
  privateHosts: [],
  captureEnabled: true,
};

export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "") || defaultSettings.serverUrl;
}
