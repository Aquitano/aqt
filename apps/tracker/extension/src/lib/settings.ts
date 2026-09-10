import { type } from "arktype";

// The OIDC keys are optional so settings saved before authentication existed
// still decode; an absent issuer is what "no authentication" means.
export const Settings = type({
  serverUrl: "string",
  privateHosts: "string[]",
  captureEnabled: "boolean",
  "oidcIssuer?": "string",
  "oidcClientId?": "string",
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
