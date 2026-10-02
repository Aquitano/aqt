# @aqt/tracker-extension

Chromium (MV3) extension for `apps/tracker`. It records page views and active time, and uploads the HTML of pages that match a capture rule published by the local `tracker serve`. The contract is `../DESIGN.md`.

## Build and load

From the repo root:

```
bun install
bun run --cwd apps/tracker/extension build
```

The build lands in `apps/tracker/extension/.output/chrome-mv3/`. Open `chrome://extensions`, enable Developer mode, click "Load unpacked" and pick that directory. `bun run --cwd apps/tracker/extension dev` runs WXT in watch mode and opens a Chromium profile with the extension loaded.

## Configure

Open the extension's options page (the popup's "Options" link, or `chrome://extensions` > Details > Extension options):

- **Server URL**, default `http://127.0.0.1:8490`. The server publishes the capture rules and receives events and captures.
- **Private hosts**, one per line. A host covers its subdomains (`example.com` also covers `mail.example.com`).
- **Capture HTML** on or off. Off means page views and spans still flow, no HTML is ever serialised.

The popup shows connected/unreachable, pending events and captures in the outbox, the last sync, the last error, the last 100 diagnostic lines, and a "Capture now" button for the active tab.

## What it records

- **Page views**: the URL, the title, when it started, how it was reached (`load`, `spa`, `reload`, `back_forward`), the previous page in the same tab as referrer and a per-tab session id. A new page view starts on every top-level navigation and on SPA URL changes where the path changes or a query key the matching rule lists (for example `v` on YouTube) changes. Hash-only and other query-only changes do not count.
- **Activity spans**: the time a page view is in the active tab of the focused window while the machine is not idle (60 s threshold), with a heartbeat every 30 s and the reason it ended (tab switch, window blur, idle, navigation, tab closed, or unknown after a browser crash).
- **HTML captures**: `document.documentElement.outerHTML` of a page whose URL matches a capture rule, once per page view after the rule's dwell time, plus manual captures from the popup. Rules come from the server and are cached for an hour; without cached rules nothing is captured. A capture is skipped when the page exceeds the rule's byte limit or when the server's `/healthz` is failing. Dwell timers use `chrome.alarms`; Chromium honours sub-30 s alarms only for unpacked extensions, a packed build would round a 5 s dwell up to 30 s.

Everything is queued in IndexedDB and sent to the server with exponential backoff (2 s doubling to 5 min). Rows are deleted after the server confirms with a 2xx. Captures wait while any event is queued, because the page view a capture references has to reach the server first. A 4xx other than 408 and 429 is permanent: the row is dropped, counted in the popup, and logged with the server's error text; 408, 429, 5xx and network failures keep retrying.

## What it never records

- Anything from **incognito** windows: the manifest declares `"incognito": "not_allowed"`, so the extension does not run there at all.
- Titles or HTML of **private hosts**. Those page views carry only `https://host/` and `private: true`; the popup's manual capture refuses them too.
- Anything from non-http(s) pages (`chrome://`, `file://`, `about:blank`).
- Form input, keystrokes, scroll positions, or anything the page does. The content script observes DOM mutations only to keep a dirty flag that nothing acts on yet.
- Anything sent to a host other than the configured server URL.

## Layout

```
wxt.config.ts               manifest and permissions
src/entrypoints/
  background.ts             service worker: wires browser events to lib/tracker.ts
  page.content.ts           isolated world: serialises HTML on request, forwards SPA URL changes
  history-hook.content.ts   page world: patches pushState/replaceState to raise an event
  popup/, options/          plain HTML + TypeScript
src/lib/
  tracker.ts                page view, span, capture and sync orchestration
  rules.ts, page-view.ts, privacy.ts, backoff.ts   pure, unit tested
  outbox.ts                 IndexedDB queue
  api.ts                    HTTP calls, responses decoded with ArkType
  storage.ts                typed chrome.storage accessors
  events.ts, messages.ts    wire and message schemas
```

`bun run --cwd apps/tracker/extension test` runs the pure-module tests; `typecheck` and `lint` are the usual `tsc --noEmit` and `oxlint --type-aware`.
