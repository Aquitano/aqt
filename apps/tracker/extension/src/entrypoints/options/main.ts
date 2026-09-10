import { authState, redirectUri, signIn, signOut } from "../../lib/auth.ts";
import { element } from "../../lib/dom.ts";
import { normalizeServerUrl } from "../../lib/settings.ts";
import { loadSettings, settingsStore } from "../../lib/storage.ts";

const serverUrl = element("server-url", HTMLInputElement);
const privateHosts = element("private-hosts", HTMLTextAreaElement);
const captureEnabled = element("capture-enabled", HTMLInputElement);
const oidcIssuer = element("oidc-issuer", HTMLInputElement);
const oidcClientId = element("oidc-client-id", HTMLInputElement);
const saved = element("saved", HTMLSpanElement);
const authStatus = element("auth-status", HTMLSpanElement);
const signInButton = element("sign-in", HTMLButtonElement);
const signOutButton = element("sign-out", HTMLButtonElement);

const label = {
  off: "no issuer configured, requests go out unauthenticated",
  in: "signed in",
  out: "signed out",
} as const;

async function fill(): Promise<void> {
  const settings = await loadSettings();
  serverUrl.value = settings.serverUrl;
  privateHosts.value = settings.privateHosts.join("\n");
  captureEnabled.checked = settings.captureEnabled;
  oidcIssuer.value = settings.oidcIssuer ?? "";
  oidcClientId.value = settings.oidcClientId ?? "";

  const state = await authState();
  authStatus.textContent = label[state];
  authStatus.dataset.state = state;
  signInButton.disabled = state === "off";
  signOutButton.disabled = state !== "in";
}

async function save(): Promise<void> {
  await settingsStore.set({
    serverUrl: normalizeServerUrl(serverUrl.value),
    privateHosts: privateHosts.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    captureEnabled: captureEnabled.checked,
    oidcIssuer: oidcIssuer.value.trim(),
    oidcClientId: oidcClientId.value.trim(),
  });
  await fill();
  saved.textContent = "saved";
}

element("form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

signInButton.addEventListener("click", () => {
  void (async () => {
    authStatus.textContent = "signing in";
    const result = await signIn();
    if (!result.ok) {
      authStatus.textContent = result.error;
      authStatus.dataset.state = "out";
      return;
    }
    await fill();
  })();
});

signOutButton.addEventListener("click", () => {
  void (async () => {
    await signOut();
    await fill();
  })();
});

element("redirect-uri", HTMLElement).textContent = redirectUri();

void fill();
