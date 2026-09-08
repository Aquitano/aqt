import { defineConfig } from "wxt";

export default defineConfig({
  browser: "chrome",
  manifestVersion: 3,
  imports: false,
  srcDir: "src",
  manifest: {
    name: "aqt tracker",
    description:
      "Browsing memory: page views, active time and HTML captures into a local tracker server.",
    incognito: "not_allowed",
    permissions: ["storage", "tabs", "webNavigation", "idle", "alarms"],
    host_permissions: ["http://*/*", "https://*/*"],
  },
});
