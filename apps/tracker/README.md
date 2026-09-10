# tracker

Browsing memory: a Chromium extension records page views and active time and snapshots the HTML of pages you read; a macOS menu-bar agent records which desktop app and window has focus; a local Go server turns the snapshots into searchable structured records in Postgres and the spans into work blocks and context-switch metrics. Two products of equal weight — recall over what I read, and attention analytics over where the time went. See [DESIGN.md](DESIGN.md) for the architecture.

## Quickstart

```sh
docker compose -f deploy/docker-compose.yml up -d   # ParadeDB, Prometheus, Grafana
go run ./cmd/tracker serve                          # migrates on startup
```

Load the extension unpacked in `chrome://extensions` (developer mode) from `extension/.output/chrome-mv3`, built with `bun run --filter @aqt/tracker-extension dev`.

Grafana is at <http://127.0.0.1:3090> — anonymous admin, dashboard `tracker`, both datasources provisioned.

## Always on

`serve` runs as a LaunchAgent, so it starts at login and comes back if it dies:

```sh
mise run tracker:service      # build the binary, install the agent, start it
mise run tracker:logs         # ~/Library/Logs/tracker.log
mise run tracker:install      # rebuild and restart after a change
mise run tracker:service:stop # stop it and remove the agent
```

[deploy/com.aqt.tracker.plist](deploy/com.aqt.tracker.plist) is copied to `~/Library/LaunchAgents` and runs `~/.local/bin/tracker`; the tasks use `launchctl bootstrap`/`bootout`, which replace the deprecated `load`/`unload`. Put `TRACKER_*` overrides in its `EnvironmentVariables` and re-run `tracker:service`.

Nothing here starts Postgres. Turn on Docker Desktop's _Start Docker Desktop when you sign in_, and the compose stack comes back with it (`restart: unless-stopped` on all three). Until it does, `serve` exits and launchd retries every 30 s; no data is lost meanwhile, the extension queues its events and pauses capture while the server is unreachable.

## Desktop agent

`desktop/` is a Swift menu-bar agent that does for native apps what the extension does for pages: it records which app and window has focus and posts the same `span_start`/`span_heartbeat`/`span_end` events to `/v1/events/batch`. No dock icon, no windows, one status item.

```sh
mise run tracker:desktop:service      # build, install to ~/Applications, start at login
mise run tracker:desktop:logs         # log stream, subsystem com.aquitano.tracker-agent
mise run tracker:desktop:build        # rebuild only
mise run tracker:desktop:service:stop # stop it and remove the agent
```

[deploy/com.aqt.tracker-agent.plist](deploy/com.aqt.tracker-agent.plist) is copied to `~/Library/LaunchAgents` and runs `~/Applications/TrackerAgent.app`. Put `TRACKER_*` overrides in its `EnvironmentVariables` and re-run `tracker:desktop:service`.

Window titles need Accessibility. Grant it in System Settings > Privacy & Security > Accessibility for `~/Applications/TrackerAgent.app`, the copy launchd runs, not the one in `DerivedData`; the menu has an item that opens that pane. Without the grant the agent records app-level spans with no title and re-checks every 30 seconds, so granting takes effect without a restart. The app is ad-hoc signed, so its identity changes on every rebuild and macOS may drop the grant: if titles stop appearing after `tracker:desktop:service`, remove the entry from the Accessibility list and add it again.

One span at a time: app name, bundle id and the focused window title, ended with `app_switch`, `window_change`, `idle` (60 s without input, a locked screen, a sleeping display or a sleeping machine) or `unknown` when the agent quits. Heartbeats every 30 s. Events queue in memory and flush every 10 s or at 100 pending, with backoff to 5 minutes while the server is unreachable.

Chromium browsers are on the skip list, so no span opens while one is frontmost: the extension already records that time and counting it twice would double every browsing hour. Apps on the private list (1Password, Keychain Access, Passwords by default) get a span with the app name and never a window title.

| Variable                     | Default                                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRACKER_SERVER_URL`         | `http://127.0.0.1:8490`                                                                                                                                                          |
| `TRACKER_TOKEN_PATH`         | the CLI's `token.json` under the user config directory; set it empty to send no token at all                                                                                     |
| `TRACKER_SKIP_BUNDLE_IDS`    | `com.google.Chrome,com.google.Chrome.canary,com.google.Chrome.beta,org.chromium.Chromium,com.brave.Browser,com.microsoft.edgemac,company.thebrowser.Browser,com.vivaldi.Vivaldi` |
| `TRACKER_PRIVATE_BUNDLE_IDS` | `com.1password.1password,com.apple.keychainaccess,com.apple.Passwords`                                                                                                           |

An empty list means no entries; an unset one keeps the default. The same holds
for the token path: unset finds the CLI's session, empty means no token.

The agent shares that session file with the CLI, so `tracker login` once signs in
both. It refreshes the access token itself and writes the result back, rotated
refresh token included, so it keeps running without anyone at a terminal.

## CLI

```
tracker serve [--listen 127.0.0.1:8490] [--workers 3]
tracker migrate
tracker reprocess [--extractor name] [--failed] [--all]
tracker login
tracker logout
tracker stats [--json]
tracker search [--extractor name] [--limit n] [--json] <query>
```

`reprocess --all` rebuilds every derived row from the source tables alone.

`stats` and `search` read the server over HTTP, so they work against a tracker
on another machine; `serve`, `migrate` and `reprocess` need the database.

## Ports

| What            | Address                             |
| --------------- | ----------------------------------- |
| Postgres        | `127.0.0.1:5434`, db/user `tracker` |
| `tracker serve` | `127.0.0.1:8490`                    |
| Prometheus      | `127.0.0.1:9091`                    |
| Grafana         | `127.0.0.1:3090`                    |

Everything is loopback-only and unauthenticated by default; requests carrying an `Origin` that is not `chrome-extension://…` are rejected.

## Authentication

Off while `TRACKER_OIDC_ISSUER` is empty, which is what loopback and the tests
run on. Set it, along with `TRACKER_OIDC_AUDIENCE`, and every route but
`/healthz` and `/metrics` needs a bearer token that the issuer signed; those two
stay open so Prometheus can scrape and the extension can tell a server that is
down from one it is not signed in to.

Any OIDC provider works. With authentik, create an OAuth2 provider, **select a
signing key** so tokens are signed RS256 against a JWKS rather than
symmetrically with a client secret a public client does not have, and enable the
device code flow on the brand for the CLI. Use the issuer exactly as the
provider publishes it, trailing slash and all: both halves compare it against
the discovery document.

The LaunchAgent reads no shell profile, so `TRACKER_OIDC_*` exported from
`~/.zshrc` reaches your terminal but **not** the server launchd starts, which
would then accept every request. Put them in the plist's `EnvironmentVariables`
and re-run `mise run tracker:service`.

```sh
tracker login    # device code: open the URL it prints, approve, done
tracker logout
```

The token lands in `$TRACKER_TOKEN_PATH` (by default under the user config
directory) at mode 600 and refreshes itself; a rotated refresh token is written
back, so signing in is a once-per-refresh-token-lifetime thing. The desktop
agent reads and refreshes the same file, so one login covers both.

The extension signs in from its options page. Paste the issuer and client id
there, then use the redirect URI it shows for the provider. Pin a `key` in the
manifest if you want that URI to survive a reload of the unpacked extension —
without one Chrome reassigns the extension id, and the URI changes with it.

## What is recorded

Every top-level navigation and SPA URL change as a page view, active time as spans (tab focused, window focused, not idle), and the full HTML of pages you read. Site extractors (github, x, youtube) snapshot after 5 s of active time; every other page is snapshotted by the `article` fallback after 30 s, which strips navigation, ads and footers with readability and keeps the prose and its metadata. Pages with under 200 characters of prose are recorded as `no_match`. The popup's capture-now button works on any page. Rules marked `after_quiet` (github, x) are snapshotted again once the page has stopped changing for 30 seconds and at least 5 minutes have passed since the last snapshot, so a thread or a pull request that grew while the tab stayed open is stored in its final state; an unchanged page is never snapshotted twice. Raw HTML is kept forever, zstd-compressed and content-addressed, so a fixed extractor can be replayed over it.

With the desktop agent installed, the frontmost app, its bundle id and its window title are recorded as spans in the same table while the machine is not idle. Spans map to categories (`Focus/Code`, `Communication`, `Distraction`, `Learning`) through regex rules in the `category_rules` table, which you edit in SQL; the Grafana dashboard shows minutes per category and per app, context switches per hour and the day's work blocks (spans stitched together while the gap stays under 60 s), all computed from SQL views over the spans.

Never recorded: anything from an incognito tab, and the title or HTML of a host on the private list — those page views keep the host and nothing else. Window titles are capped at 512 characters and nothing beyond the title is read from a desktop app. Capture pauses entirely while the server is unreachable.

Config via env, see [.env.example](.env.example).
