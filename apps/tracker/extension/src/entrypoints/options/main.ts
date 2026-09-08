import { element } from "../../lib/dom.ts";
import { normalizeServerUrl } from "../../lib/settings.ts";
import { loadSettings, settingsStore } from "../../lib/storage.ts";

const serverUrl = element("server-url", HTMLInputElement);
const privateHosts = element("private-hosts", HTMLTextAreaElement);
const captureEnabled = element("capture-enabled", HTMLInputElement);
const saved = element("saved", HTMLSpanElement);

async function fill(): Promise<void> {
  const settings = await loadSettings();
  serverUrl.value = settings.serverUrl;
  privateHosts.value = settings.privateHosts.join("\n");
  captureEnabled.checked = settings.captureEnabled;
}

async function save(): Promise<void> {
  await settingsStore.set({
    serverUrl: normalizeServerUrl(serverUrl.value),
    privateHosts: privateHosts.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    captureEnabled: captureEnabled.checked,
  });
  await fill();
  saved.textContent = "saved";
}

element("form", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});

void fill();
