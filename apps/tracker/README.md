# tracker

Browsing memory: a Chromium extension records page views and active time and snapshots the HTML of pages you read; a macOS menu-bar agent and a Windows tray agent record which desktop app and window has focus; a Go server on the VPS turns the snapshots into searchable structured records in Postgres and the spans into work blocks and context-switch metrics. Two products of equal weight — recall over what I read, and attention analytics over where the time went. See [DESIGN.md](DESIGN.md) for the architecture.

## Quickstart

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.laptop.yml up -d   # ParadeDB, daily backups, Prometheus, Grafana
go run ./cmd/tracker serve                                                        # migrates on startup
```

[docker-compose.yml](docker-compose.yml) is the stack the VPS runs, the server itself included under the `server` profile. [deploy/docker-compose.laptop.yml](deploy/docker-compose.laptop.yml) adds what a laptop running `serve` natively wants on top: Prometheus, the dashboard that reads it, Grafana without a login, and restart policies. Pass both files to `up`; every other `docker compose` command below works with the first alone, from this directory.

Load the extension unpacked in `chrome://extensions` (developer mode) from `extension/.output/chrome-mv3`, built with `bun run --filter @aqt/tracker-extension build`. Keep it unpacked: Chromium honours the 5 s capture timers only for unpacked extensions. `dev` is for working on the extension; it writes to `chrome-mv3-dev` and opens a browser profile of its own.

Before browsing with it, list your private hosts on the extension's options page: webmail, banking, health portals, anything whose pages you would not want kept forever. The list is empty by default, and the `article` fallback snapshots any page you stay on for 30 seconds. A host added later keeps what was recorded before it was added; `tracker forget --host` removes that.

Grafana is at <http://127.0.0.1:3090> — anonymous admin, dashboards `tracker` (Postgres) and `tracker server` (Prometheus). The per-day panels bucket by the database's time zone, UTC unless set: `docker compose exec db psql -U tracker -d tracker -c "alter database tracker set timezone to 'Europe/London'"` with your zone, then `docker compose restart grafana` so its pooled connections pick it up.

## Always on

On a laptop that is its own server, `serve` runs as a LaunchAgent, so it starts at login and comes back if it dies:

```sh
mise run tracker:service      # build the binary, install the agent, start it
mise run tracker:logs         # ~/Library/Logs/tracker.log
mise run tracker:install      # rebuild and restart after a change
mise run tracker:service:stop # stop it and remove the agent
```

[deploy/com.aqt.tracker.plist](deploy/com.aqt.tracker.plist) is copied to `~/Library/LaunchAgents` and runs `~/.local/bin/tracker`; the tasks use `launchctl bootstrap`/`bootout`, which replace the deprecated `load`/`unload`. Put `TRACKER_*` overrides in its `EnvironmentVariables` and re-run `tracker:service`.

Nothing here starts Postgres. Turn on Docker Desktop's _Start Docker Desktop when you sign in_, and the compose stack comes back with it (`restart: unless-stopped` on every service). Until it does, `serve` exits and launchd retries every 30 s; no data is lost meanwhile, the extension queues its events and captures while the server is unreachable.

## Backups

The compose `backup` service writes a `pg_dump` once a day to `~/Library/Application Support/tracker/backups` (`TRACKER_BACKUP_DIR` overrides it) and keeps the newest three, so what `tracker forget` deletes survives in them for up to three days. That directory is only on this disk: Time Machine, or anything else that copies it off the machine, is what makes it a backup. `docker compose logs backup` shows each run.

To restore, stop the server, replace the database with a dump, start it again:

```sh
mise run tracker:service:stop
docker compose exec -T db \
  pg_restore -U tracker -d tracker --clean --if-exists < "$HOME/Library/Application Support/tracker/backups/tracker-<stamp>.dump"
mise run tracker:service
```

## Upgrading ParadeDB

The image is pinned by version and digest in [docker-compose.yml](docker-compose.yml). Stay on the `-pg18` line: the data directory is named after the Postgres major, so another major starts on an empty one and needs a dump and restore. After changing the pin:

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.laptop.yml up -d
docker compose exec db psql -U tracker -d tracker -c 'alter extension pg_search update'
```

## Desktop agent

`desktop/` is a Swift menu-bar agent that does for native apps what the extension does for pages: it records which app and window has focus and posts the same `span_start`/`span_heartbeat`/`span_end` events to `/v1/events/batch`. No dock icon, no windows, one status item.

```sh
mise run tracker:desktop:service      # build, install to ~/Applications, start at login
mise run tracker:desktop:logs         # log stream, subsystem com.aquitano.tracker-agent
mise run tracker:desktop:build        # rebuild only
mise run tracker:desktop:service:stop # stop it and remove the agent
```

[deploy/com.aqt.tracker-agent.plist](deploy/com.aqt.tracker-agent.plist) is copied to `~/Library/LaunchAgents` and runs `~/Applications/TrackerAgent.app`. Put `TRACKER_*` overrides in its `EnvironmentVariables` and re-run `tracker:desktop:service`. launchd restarts the agent after a crash but not after Quit, so Quit pauses tracking until the next login.

Window titles need Accessibility. Grant it in System Settings > Privacy & Security > Accessibility for `~/Applications/TrackerAgent.app`, the copy launchd runs, not the one in `DerivedData`; the menu has an item that opens that pane. Without the grant the agent records app-level spans with no title and re-checks every 30 seconds, so granting takes effect without a restart. The app is ad-hoc signed, so its identity changes on every rebuild and macOS may drop the grant: if titles stop appearing after `tracker:desktop:service`, remove the entry from the Accessibility list and add it again.

One span at a time: app name, bundle id and the focused window title, ended with `app_switch`, `window_change`, `idle` (60 s without input, a locked screen, a sleeping display or a sleeping machine; dated to the last input, not to when the agent noticed) or `unknown` when the agent quits. Heartbeats every 30 s. Events queue in `~/Library/Application Support/tracker/outbox/<device-id>.json` and flush every 10 s or at 100 pending, with backoff to 5 minutes while the server is unreachable. Each enqueue and batch acknowledgement atomically replaces the file with owner-only permissions. Pending events survive restarts. The queue keeps up to 10,000 events and drops the oldest on overflow. An unreadable queue stays untouched for recovery; the menu reports the storage error.

Chromium browsers are on the skip list, so no span opens while one is frontmost: the extension already records that time and counting it twice would double every browsing hour. Apps on the private list (1Password, Keychain Access, Passwords by default) get a span with the app name and never a window title. Apps on the ignore list (the Dock, password prompts, notifications, menu-bar overlays by default) are focus without attention: the span underneath stays open.

| Variable                     | Default                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRACKER_SERVER_URL`         | `http://127.0.0.1:8490`                                                                                                                                                           |
| `TRACKER_TOKEN_PATH`         | the CLI's `token.json` under the user config directory; set it empty to send no token at all                                                                                      |
| `TRACKER_SKIP_BUNDLE_IDS`    | `com.google.Chrome,com.google.Chrome.canary,com.google.Chrome.beta,org.chromium.Chromium,com.brave.Browser,com.microsoft.edgemac,company.thebrowser.Browser,com.vivaldi.Vivaldi`  |
| `TRACKER_PRIVATE_BUNDLE_IDS` | `com.1password.1password,com.apple.keychainaccess,com.apple.Passwords`                                                                                                            |
| `TRACKER_IGNORE_BUNDLE_IDS`  | `com.apple.dock,com.apple.loginwindow,com.apple.SecurityAgent,com.apple.LocalAuthentication.UIAgent,com.apple.UserNotificationCenter,com.jordanbaird.Ice,com.electron.wispr-flow` |

An empty list means no entries; an unset one keeps the default. The same holds
for the token path: unset finds the CLI's session, empty means no token.

The agent shares that session file with the CLI, so `tracker login` once signs in
both. It refreshes the access token itself and writes the result back, rotated
refresh token included, so it keeps running without anyone at a terminal.

## Windows agent

`cmd/tracker-agent` is the desktop agent for Windows, in Go: a notification-area icon that records which app and window has focus and posts the same span events as the macOS agent. One static exe, no console window, no admin rights.

```sh
mise run tracker:agent:windows:build   # cross-compiles dist/tracker-agent.exe from any OS
```

Copy the exe where it will stay, such as `%LOCALAPPDATA%\Programs\tracker\tracker-agent.exe`, and run it from there:

```powershell
tracker-agent.exe install     # start at every sign-in and start now
tracker-agent.exe uninstall   # stop starting at sign-in; Quit in the tray stops it now
```

`install` writes the exe's path to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, so run it again after moving the exe. One agent runs per sign-in session; starting another does nothing. Nothing restarts the agent after a crash, as launchd does on macOS: it comes back at the next sign-in, or when you start it.

The tray menu shows whether the server answers, what is tracked, the queue, the last error, and Pause for 1 hour, Resume and Quit. Pause ends the open span as `paused`, like the extension's pause; Quit, and signing out, end it as `unknown` and flush the queue. With authentication on, sign in once with the CLI built for Windows (`GOOS=windows go build ./cmd/tracker`, then `tracker.exe login`); the agent reads and refreshes the same `%APPDATA%\tracker\token.json`.

What it records matches the macOS agent: one span at a time with the app name, the bundle id and the window title, ended with `app_switch`, `window_change`, `idle` (60 s without input, a locked session or a sleeping machine; dated to the last input) or `unknown`, heartbeats every 30 s. The app name is the exe's file description (`Visual Studio Code` for `Code.exe`), or the exe name without one; the bundle id is the exe name in lower case (`code.exe`); a store app counts as itself, not as the `ApplicationFrameHost.exe` that draws its frame. Window titles need no permission on Windows. A title change counts once it has held for a second, so a title that ticks or follows typing does not split the span per keystroke.

The lists, the server and the token path are the macOS agent's variables, set as user environment variables (`setx TRACKER_SERVER_URL http://…`) and read when the agent starts. The lists hold exe names. The ignore list also takes window classes, because `explorer.exe` draws the taskbar, the desktop and Alt+Tab as well as File Explorer windows: its shell surfaces are ignored by class, and a File Explorer window is an app like any other.

| Variable                     | Default on Windows                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRACKER_SERVER_URL`         | `http://127.0.0.1:8490`                                                                                                                                                                                                                                                                                                    |
| `TRACKER_TOKEN_PATH`         | the CLI's `token.json` under `%APPDATA%`; set it empty to send no token at all                                                                                                                                                                                                                                             |
| `TRACKER_SKIP_BUNDLE_IDS`    | `chrome.exe,msedge.exe,brave.exe,vivaldi.exe,arc.exe,opera.exe,chromium.exe`                                                                                                                                                                                                                                               |
| `TRACKER_PRIVATE_BUNDLE_IDS` | `1password.exe,bitwarden.exe,keepassxc.exe,keepass.exe`                                                                                                                                                                                                                                                                    |
| `TRACKER_IGNORE_BUNDLE_IDS`  | `lockapp.exe,searchhost.exe,searchapp.exe,startmenuexperiencehost.exe,shellexperiencehost.exe,shellhost.exe,credentialuibroker.exe,shell_traywnd,shell_secondarytraywnd,progman,workerw,xamlexplorerhostislandwindow,multitaskingviewframe,foregroundstaging,notifyiconoverflowwindow,toplevelwindowforoverflowxamlisland` |
| `TRACKER_LOG_LEVEL`          | `info`; `debug` logs every span's app and end reason, never a title                                                                                                                                                                                                                                                        |

Everything else lives under `%LOCALAPPDATA%\tracker`:

| File                       | What                                                    |
| -------------------------- | ------------------------------------------------------- |
| `outbox\<device-id>.jsonl` | events not yet acknowledged, one JSON object per line   |
| `device-id`                | the agent's `device_id`, a UUIDv7 made on the first run |
| `agent.log`                | the log, rotated at 1 MB with one old file kept         |

The outbox flushes every 10 s or at 100 pending, with backoff to 5 minutes while the server cannot take a batch. An enqueue appends a line; the file is rewritten only after a batch is acknowledged. It keeps up to 10,000 events and drops the oldest on overflow. A crash in the middle of an append costs that event, not the queue. An outbox that cannot be read is renamed to `<device-id>.jsonl.unreadable-<n>`, never overwritten, and a new one is started.

## CLI

```
tracker serve [--listen 127.0.0.1:8490] [--workers 3]
tracker migrate
tracker reprocess [--extractor name] [--failed] [--all]
tracker blob <hash-or-url>
tracker login
tracker logout
tracker stats [--json]
tracker search [--extractor name] [--limit n] [--json] <query>
tracker show [--json] <record-id>
tracker visits [--json] <url>
tracker time [--since 24h] [--until when] [--by host|app|category] [--json]
tracker forget <url>
tracker forget --host <host>
tracker healthcheck
```

`serve` queues every capture the current extractor versions have not processed yet when it starts, so a release that bumps one needs no manual step. `reprocess` also removes the records only an older version produced; `reprocess --all` rebuilds every derived row from the source tables alone.

`stats`, `search`, `show`, `visits`, `time`, `forget` and `healthcheck` go over
HTTP, so they work against a tracker on another machine; `serve`, `migrate`,
`reprocess` and `blob` need the database. `healthcheck` exits 0 when the server's
`/healthz` answers, which needs no token; it is the container's healthcheck, since
the image has no shell or HTTP client of its own.

Each search hit carries its visits: how many page views captured the record's
page or were at its canonical URL, the first and last of them, and their active
time. `show` prints one record in full, search text included. `visits` answers
the same for any URL, normalised like ingest does, captured or not: whether a
page was seen before and when.

`time` sums active time over a window, each span clipped to it: browser time per
host, desktop time per app, or both per category, like the dashboard's panels.
`--since` and `--until` take a duration back from now (`90m`, `24h`, `7d`) or a
local date (`2026-10-01`, meaning its midnight); the window defaults to the last
24 hours.

`forget` deletes everything recorded for a page, or for a host and its
subdomains, and prints what went: page views with their spans and captures, the
HTML no other capture shares, the records built from either, and the URLs.
Other pages that linked to it lose the referrer. A record whose HTML another
page also captured is rebuilt from that page. A public suffix such as `com` is
refused, since it would take every site under it. The backups still hold what
was forgotten until they rotate out, three daily dumps later, and so does any
copy of them, Time Machine's included, for as long as that copy is kept.

Agents get these commands through a Claude Code skill: [skill/README.md](skill/README.md).

`blob` writes the HTML of a stored capture to stdout, for turning a real page
into an extractor fixture: 64 hex characters name a blob, anything else is a
URL, normalised like ingest does, whose most recent capture it writes.

## Ports

| What            | Laptop                              | VPS                       |
| --------------- | ----------------------------------- | ------------------------- |
| Postgres        | `127.0.0.1:5435`, db/user `tracker` | `127.0.0.1:5435`          |
| `tracker serve` | `127.0.0.1:8490`                    | the tailnet address, 8490 |
| Prometheus      | `127.0.0.1:9091`                    | not run                   |
| Grafana         | `127.0.0.1:3090`                    | the tailnet address, 3090 |

Everything is loopback-only and unauthenticated by default; the VPS's `.env` publishes the server and Grafana on its tailnet address and turns authentication on (Deploying to the VPS). Requests carrying an `Origin` that is not `chrome-extension://…` (or, with `TRACKER_EXTENSION_ID` set, not that one extension) are rejected, and while authentication is off, so is every request but `/healthz` and `/metrics` whose `Host` is not `127.0.0.1`, `localhost` or `[::1]`. That second check stops a DNS-rebinding page, which is same-origin with the server and sends no `Origin` on a GET.

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
there, then use the redirect URI it shows for the provider. The manifest pins
the extension id to `gdhnnekkmghgkiikgmdodggcpgnmbpno` on every machine, so that
URI is always `https://gdhnnekkmghgkiikgmdodggcpgnmbpno.chromiumapp.org/`, and
`TRACKER_EXTENSION_ID` set to the id makes `serve` refuse every other extension's
origin.

## Deploying to the VPS

One server on the VPS, and every machine tracks into it: the extension in each browser, the desktop agent and the CLI on the Mac. [docker-compose.yml](docker-compose.yml) runs it the way bank runs: a static binary on distroless as uid 65532, read-only root filesystem, no capabilities, published on the box's tailnet address only. Postgres and its daily backups live on the LUKS volume at `/data`, which is why nothing restarts on its own. Grafana reads Postgres and is on the tailnet too, behind its own login; Prometheus stays on the laptop. Authentication is on, against authentik.

### authentik

In the admin interface:

1. Applications > Providers > Create an OAuth2/OpenID provider named `tracker`: client type **Public**, a **signing key** selected (RS256; without one tokens are signed with a client secret a public client does not have), and the `offline_access` scope mapping added to the default ones so clients get refresh tokens. Redirect URIs come later, from the extension. Note the client id.
2. Applications > Create an application with slug `tracker` and that provider. The issuer is then `https://auth.aquitano.me/application/o/tracker/`, trailing slash included.
3. System > Brands > the brand serving auth.aquitano.me: set a **device code flow**, which `tracker login` needs. authentik ships none; its device code flow docs describe the one to create.

`curl -s https://auth.aquitano.me/application/o/tracker/.well-known/openid-configuration` should then name that issuer and a `device_authorization_endpoint`.

### First deploy

On the box as root, with `/data` unlocked and mounted (bank's [DEPLOY.md](../bank/DEPLOY.md), section 1). The tracker container writes nothing to disk, so no directory has to belong to its uid: Postgres's entrypoint takes `pgdata` over on its first start, and the backup service writes its dumps as root at mode 600.

```sh
git clone https://github.com/Aquitano/aqt.git /opt/aqt-tracker   # credentials as for the gallery's checkout
mkdir -p /data/aqt-tracker/pgdata /data/aqt-tracker/backups
chmod 700 /data/aqt-tracker/backups
```

`/opt/aqt-tracker/apps/tracker/.env`, mode 600, or keep it in Infisical's `prod` and run `mise run tracker:secrets:send` from the laptop:

```sh
COMPOSE_PROFILES=server
POSTGRES_PASSWORD=<openssl rand -hex 24>   # before the first up: Postgres keeps the one it starts with
TRACKER_PG_DIR=/data/aqt-tracker/pgdata
TRACKER_BACKUP_DIR=/data/aqt-tracker/backups
TRACKER_LISTEN=100.x.y.z:8490              # `tailscale ip -4`; never 0.0.0.0, there is no TLS
TRACKER_GRAFANA_LISTEN=100.x.y.z:3090
TRACKER_GRAFANA_PASSWORD=<another one>
TRACKER_OIDC_ISSUER=https://auth.aquitano.me/application/o/tracker/
TRACKER_OIDC_AUDIENCE=<client id>
```

On the Mac, stop the local server and dump its database, from `apps/tracker`. The extension and the desktop agent queue meanwhile:

```sh
mise run tracker:service:stop
docker compose exec -T db pg_dump -U tracker -d tracker -Fc > ~/tracker.dump
scp ~/tracker.dump root@ubuntu:/data/aqt-tracker/ && rm ~/tracker.dump
```

Back on the box, restore it into the empty database before the server first starts, then start everything:

```sh
cd /opt/aqt-tracker/apps/tracker
docker compose up -d db
docker compose exec -T db pg_restore -U tracker -d tracker --clean --if-exists < /data/aqt-tracker/tracker.dump
docker compose exec db psql -U tracker -d tracker -c "alter database tracker set timezone to 'Europe/Berlin'"
docker compose up -d --build
curl -s http://100.x.y.z:8490/healthz      # {"db":true,"ok":true}
rm /data/aqt-tracker/tracker.dump
```

The time zone is the one Grafana's per-day panels bucket by; a dump does not carry it. Grafana is at `http://100.x.y.z:3090`, user `admin`. Once the clients below see their history, retire the Mac's stack, keeping its volumes until you no longer want the local copy:

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.laptop.yml down
```

Later deploys are `mise run tracker:deploy` from the laptop. `tracker reprocess`, `migrate` and `blob` run on the box as `docker compose run --rm tracker <command>`.

### Pointing the clients at it

- **Extension**, in each browser on each machine: on the options page, the server URL `http://100.x.y.z:8490`, the issuer and the client id, then sign in. The manifest pins the extension id, so the provider needs one redirect URI for every browser: `https://gdhnnekkmghgkiikgmdodggcpgnmbpno.chromiumapp.org/`.
- **CLI**, in the shell profile, then `tracker login` once; `tracker stats` shows the restored history:
  ```sh
  export TRACKER_SERVER_URL=http://100.x.y.z:8490
  export TRACKER_OIDC_ISSUER=https://auth.aquitano.me/application/o/tracker/
  export TRACKER_OIDC_CLIENT_ID=<client id>
  ```
- **Desktop agent**: `TRACKER_SERVER_URL` in [deploy/com.aqt.tracker-agent.plist](deploy/com.aqt.tracker-agent.plist), then `mise run tracker:desktop:service`. It signs in with the CLI's token file, so `tracker login` covers it.

### After a reboot

Nothing that writes to disk comes back by itself: the bind paths would point at the unencrypted root disk until `/data` is unlocked. Add the tracker to the step that unlocks `/data` and starts bank:

```sh
docker compose -f /opt/aqt-tracker/apps/tracker/docker-compose.yml up -d
```

The server fetches authentik's discovery document as it starts and exits when that fails; its restart policy retries until authentik answers.

### While the server is down

Clients queue and lose nothing short of a long outage. The extension keeps page views, spans and captures in its outbox (the newest 10,000 events and 200 captures) and retries with backoff up to 5 minutes; the desktop agent keeps up to 10,000 events in its outbox file. Search, the seen-before badge and the CLI fail until it is back. The popup counts anything an overflowing outbox dropped.

## What is recorded

Every top-level navigation and SPA URL change as a page view, active time as spans (tab focused, window focused, not idle), and the full HTML of pages you read. Site extractors (github, hackernews, reddit, stackexchange, x, youtube) snapshot after 5 s of active time; every page on a host without its own extractor is snapshotted by the `article` fallback after 30 s, which strips navigation, ads and footers with readability and keeps the prose and its metadata. A host a site extractor names is that extractor's alone, so a YouTube home page or a GitHub issue list is never snapshotted as an article. GitHub's own pages (settings, sign-in, notifications and the like) are never snapshotted at all: a new access token is shown on one of them. Pages with under 200 characters of prose are recorded as `no_match`. The popup's capture-now button works on any page. Rules marked `after_change` (github, hackernews, reddit, stackexchange, x) are snapshotted again at most every 5 minutes while you are on the page, and when you leave it, so a thread or a pull request that grew while you read it is stored as you left it; an unchanged page is never snapshotted twice. Raw HTML is kept forever, zstd-compressed and content-addressed, so a fixed extractor can be replayed over it. GitHub issue, pull request and discussion records keep every comment the page shows, a discussion's replies under the comment they answer; Hacker News and Reddit records keep the post and every comment the page shows with its nesting depth; Stack Exchange records keep the question, every answer with its score and whether it was accepted, and the comments shown under each; and X records keep the posts shown above and below the one opened, so replies are searchable too. X records also keep the post URL and each photo's original-size image URL and alt text. Photo-only posts are indexed by author and descriptive alt text. Image URLs reference X's hosted files; the tracker does not download the image files. YouTube records keep the video's transcript, so what is said in a video is searchable too: the extension has YouTube load it into the hidden transcript panel when it captures the page, preferring manual captions in the page's language or English over auto-generated ones.

With the desktop agent installed, the frontmost app, its bundle id and its window title are recorded as spans in the same table while the machine is not idle. Spans map to categories (`Focus/Code`, `Communication`, `Distraction`, `Learning`, `AI`, `Browsing`, `Personal`, `Design`, `System`, `Productivity`) through regex rules in the `category_rules` table, which you edit in SQL; the Grafana dashboard shows minutes per category and per app, context switches per hour and the day's work blocks (spans stitched together while the gap stays under 60 s), all computed from SQL views over the spans.

Never recorded: anything from an incognito tab, and the title or HTML of a host on the private list — those page views keep the host and nothing else. Window titles are capped at 512 characters and nothing beyond the title is read from a desktop app. The desktop agent cannot tell a private browser window from any other, so a browser outside the extension's reach (Safari, Firefox) has its window titles recorded, private windows included, unless its bundle id is on `TRACKER_PRIVATE_BUNDLE_IDS`.

The extension keeps recording while the server is unreachable: page views, spans and captures wait in its outbox and upload once the server answers again. The outbox holds the newest 10,000 events and 200 captures, dropping the oldest past that, so only an outage long enough to overflow it loses anything.

Config via env, see [.env.example](.env.example).
