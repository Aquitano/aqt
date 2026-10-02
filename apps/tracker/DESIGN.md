# tracker — browsing memory

What I read and where my attention went, from a browser extension and a macOS menu-bar agent into a local Postgres. Two products of equal weight: **recall** (search over structured records extracted from pages I read) and **attention analytics** (page views, active time per site and per desktop app, work blocks, context switches). Visits are cheap events; HTML snapshots are content-addressed immutable blobs; extraction is asynchronous, idempotent and replayable.

## Decisions (locked 2026-09-08)

| Area          | Choice                                                                                                                                                                                    | Why                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime       | Go, single `tracker` binary; `serve` runs HTTP plus in-process workers                                                                                                                    | One process to supervise per machine                                                                                                                                                                                                                         |
| Supervision   | launchd LaunchAgent, `KeepAlive`, binary at `~/.local/bin/tracker`                                                                                                                        | Ingest must survive a closed terminal and a reboot; launchd is the supervisor macOS already runs, and its restart loop doubles as the wait for Postgres                                                                                                      |
| Store         | Postgres via the ParadeDB image (`pg_search` BM25)                                                                                                                                        | Same search engine as bank; no second index to sync                                                                                                                                                                                                          |
| Location      | Localhost per machine, `127.0.0.1` only                                                                                                                                                   | Privacy first; `device_id` + UUIDv7 everywhere keep a later merge a `UNION`                                                                                                                                                                                  |
| Auth          | None while no OIDC issuer is set; bearer tokens verified against the issuer's JWKS once one is. CLI and agent share one session file, each refreshing it in place                         | Loopback needs none, and the `Origin` header is not a credential off it. `/healthz` and `/metrics` stay open so a scrape and a reachability check need no token. One user, so a token answers "is this the owner" and `device_id` stays a label              |
| Capture scope | Site rules plus a universal `article` fallback gated on a 30 s dwell; a host a site rule names never falls through to the fallback; the server publishes rules, the extension caches them | Site extractors capture at 5 s; for everything else the dwell is the filter, since a 5 s dwell would capture every page you bounce off. The other pages of a site with its own extractor are app shell. Private hosts and incognito stay the only exclusions |
| Desktop       | A Swift menu-bar agent posts app/window spans to the same events endpoint, skipping the browsers the extension covers                                                                     | One span table, one ingest path; browser time is counted once, by the source that knows the page                                                                                                                                                             |
| Categories    | Config tables of regex rules, applied at query time by a view                                                                                                                             | Rules change; a stored category would need a backfill every time. Personal scale makes the regex join cheap                                                                                                                                                  |
| Work blocks   | SQL function over all devices, spans stitched when the gap is under 60 s                                                                                                                  | One person has one attention stream, and the extension and the agent carry different device ids on the same machine                                                                                                                                          |
| Extraction    | Per-site extractors in Go returning typed records, run server-side                                                                                                                        | Serialising `outerHTML` is the cheapest thing the browser can do                                                                                                                                                                                             |
| Raw HTML      | Kept forever, zstd in Go, `STORAGE EXTERNAL`                                                                                                                                              | Re-running a fixed extractor after a site changes markup is the whole reason to keep it                                                                                                                                                                      |
| Queue         | The derivation row is the job (`FOR UPDATE SKIP LOCKED`)                                                                                                                                  | Identity `(raw_hash, extractor, version)` already exists; no PGMQ                                                                                                                                                                                            |
| Dedup         | Blob hash for snapshots; one record per extractor and canonical URL, holding the newest snapshot's content                                                                                | A page changes between visits (an issue closes, an article is edited, a thread grows) and should still be one search hit; `record_hash` says whether the content changed. SimHash dropped: structured records have no prose to near-match                    |
| ORM           | uptrace/bun with `pgdriver`, SQL migrations embedded                                                                                                                                      | SQL-first with struct scanning; raw SQL where `@@@`, `SKIP LOCKED` and `ON CONFLICT` need it                                                                                                                                                                 |
| Observability | slog JSON, Prometheus `/metrics`, Grafana with Postgres datasource for analytics                                                                                                          | Metrics yes, tracing no; analytics dashboards come free from the Postgres datasource, so no web app in v1                                                                                                                                                    |
| Extension     | WXT, TypeScript, Chromium MV3 only                                                                                                                                                        | One background lifecycle to get right                                                                                                                                                                                                                        |

## Layout

```
apps/tracker/
  cmd/tracker/            serve | migrate | reprocess | blob | login | logout | stats | search | show | time | forget
  internal/
    store/                bun models, embedded migrations, queries
    ingest/               HTTP: events, captures, capture-rules, search, visits, records, time, forget, stats, healthz, metrics
    extractor/            Extractor interface, Rule, registry
    extractor/github/     one package per site
    extractor/x/
    extractor/youtube/
    extractor/article/    universal fallback (readability)
    processor/            worker loop: claim derivation, decompress, extract, write record
    auth/                 OIDC bearer verification, off when no issuer is set
    authtest/             throwaway issuer for tests
    client/               device-code login and the CLI's HTTP calls
    urlnorm/              normalisation + hash
    blob/                 blake3 + zstd
    metrics/              Prometheus collectors
  extension/              WXT extension (@aqt/tracker-extension)
  desktop/                Swift menu-bar agent (TrackerAgent.app): frontmost app and window spans
  deploy/
    docker-compose.yml    ParadeDB, backup, Prometheus, Grafana
    backup.sh             daily pg_dump loop the backup service runs
    com.aqt.tracker.plist launchd agent for `serve`
    com.aqt.tracker-agent.plist
                          launchd agent for TrackerAgent.app
    prometheus.yml
    grafana/provisioning/ datasources (Prometheus, Postgres) + dashboards
  README.md, DESIGN.md
```

## Ports and env

| What          | Value                                          |
| ------------- | ---------------------------------------------- |
| Postgres      | `127.0.0.1:5435`, db `tracker`, user `tracker` |
| tracker serve | `127.0.0.1:8490`                               |
| Prometheus    | `127.0.0.1:9091`                               |
| Grafana       | `127.0.0.1:3090`                               |

Env: `TRACKER_DATABASE_URL` (default `postgres://tracker:tracker@127.0.0.1:5435/tracker?sslmode=disable`), `TRACKER_LISTEN` (default `127.0.0.1:8490`), `TRACKER_WORKERS` (default 3), `TRACKER_LOG_LEVEL`. For authentication and the CLI: `TRACKER_SERVER_URL`, `TRACKER_OIDC_ISSUER`, `TRACKER_OIDC_AUDIENCE`, `TRACKER_OIDC_CLIENT_ID`, `TRACKER_TOKEN_PATH`.

## Schema

All timestamps `timestamptz`. All hashes are 32-byte BLAKE3 `bytea`. Ids the extension generates are UUIDv7.

```sql
urls (
  id            bigint generated always as identity primary key,
  url_hash      bytea not null unique,          -- blake3(normalized_url)
  normalized_url text not null,
  host          text not null,
  created_at    timestamptz not null default now()
);
create index on urls (host);

page_views (
  id              uuid primary key,             -- from the extension
  device_id       uuid not null,
  url_id          bigint not null references urls,
  tab_session_id  text,
  title           text,                         -- null for private hosts
  started_at      timestamptz not null,
  navigation_type text not null,                -- load | spa | reload | back_forward
  referrer_url_id bigint references urls,
  private         boolean not null default false,
  created_at      timestamptz not null default now()
);
create index on page_views (device_id, started_at desc);
create index on page_views (url_id, started_at desc);

activity_spans (
  id            uuid primary key,
  device_id     uuid not null,
  page_view_id  uuid references page_views,     -- browser span
  app_name      text,                           -- desktop span
  bundle_id     text,
  window_title  text,
  started_at    timestamptz not null,
  ended_at      timestamptz not null,           -- advanced by heartbeats
  end_reason    text,                           -- null while open; tab_switch | window_blur | app_switch | window_change | idle | navigation | tab_closed | unknown
  created_at    timestamptz not null default now(),
  check ((page_view_id is null) <> (app_name is null))
);
create index on activity_spans (device_id, started_at desc);
create index on activity_spans (started_at desc);
create index on activity_spans (page_view_id);

categories (id smallint generated always as identity primary key, name text not null unique);
category_rules (
  id            bigint generated always as identity primary key,
  category_id   smallint not null references categories,
  app_pattern   text,                           -- case-insensitive regex (~*) over app_name
  host_pattern  text,                           -- same, over the page view's host
  priority      integer not null default 0,
  check (app_pattern is not null or host_pattern is not null)
);

-- analytics, all read-only over the tables above
categorized_spans                               -- view: every span with source (page | desktop), host, category
context_switches_hourly                         -- view: per hour of ended_at, ends by tab_switch | window_blur | app_switch, and total ends
work_blocks(from_ts, to_ts, max_gap = '60 seconds') -- function: spans stitched into blocks while the gap stays under max_gap,
                                                --   with active_seconds, span_count, switches, dominant_category; global across devices

raw_html_blobs (
  hash          bytea primary key,              -- blake3(raw utf-8 html)
  codec         smallint not null,              -- 1 = zstd
  raw_bytes     integer not null,
  stored_bytes  integer not null,
  payload       bytea not null,
  created_at    timestamptz not null default now()
);
alter table raw_html_blobs alter column payload set storage external;

captures (
  id            uuid primary key,
  page_view_id  uuid not null references page_views,
  device_id     uuid not null,
  raw_hash      bytea not null references raw_html_blobs,
  extractor     text not null,                  -- rule that matched
  captured_at   timestamptz not null,
  reason        text not null,                  -- initial | recapture | manual
  url           text not null,                  -- exact URL at capture time
  browser_title text,
  raw_char_count integer,
  created_at    timestamptz not null default now()
);
create index on captures (page_view_id);
create index on captures (raw_hash);
create index on captures (captured_at desc);

derivations (
  raw_hash          bytea not null references raw_html_blobs,
  extractor         text not null,
  extractor_version integer not null,
  status            text not null default 'pending', -- pending | running | done | failed
  attempts          integer not null default 0,
  claimed_at        timestamptz,
  last_error        text,
  error_class       text,                       -- panic | parse | no_match | stale | timeout | too_large | unregistered | store | abandoned
  record_id         bigint references records,
  processing_ms     integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (raw_hash, extractor, extractor_version)
);
create index on derivations (status, created_at) where status in ('pending', 'running');

records (
  id            bigint generated always as identity primary key,
  extractor     text not null,
  record_hash   bytea not null,                 -- blake3(canonical json of data); changes with the content
  url_id        bigint not null references urls,
  canonical_url text not null,                  -- normalised; the page URL when the extractor names none
  title         text,
  search_text   text not null,                  -- what BM25 sees; built by the extractor
  data          jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  unique (extractor, canonical_url)
);
create index records_search on records using bm25 (id, title, search_text, extractor)
  with (key_field = 'id');
```

Source data: `urls`, `page_views`, `activity_spans`, `raw_html_blobs`, `captures`. Derived: `derivations`, `records`. Config, seeded by migration and edited in SQL: `categories`, `category_rules`. `tracker reprocess --all` must rebuild the derived tables from source alone and never touches config; that property has a test.

## Ingest transaction for a capture

1. Read multipart: `meta` (JSON) and `html` (text/html). Reject over 25 MiB before buffering; reject over the rule's `max_bytes` with 413.
2. `hash = blake3(html)`, `payload = zstd(html, level 3)`.
3. One transaction: check that `page_view_id` is on file; upsert `urls`; `INSERT raw_html_blobs ON CONFLICT DO NOTHING`; `INSERT captures`; `INSERT derivations (hash, extractor, current version, pending) ON CONFLICT DO NOTHING`.
4. Respond `201 {capture_id, raw_hash (hex), deduplicated: bool}`. An unknown page view gets 422 with nothing written: the extension uploads a capture only once the events queued before it are acknowledged, so a retry could never succeed. On any other failure respond 5xx with nothing written; the extension keeps the capture in its outbox.

## Worker

`serve` runs `TRACKER_WORKERS` goroutines. Each loop:

```sql
update derivations set status = 'running', claimed_at = now(), attempts = attempts + 1
where (raw_hash, extractor, extractor_version) in (
  select raw_hash, extractor, extractor_version from derivations
  where status = 'pending' or (status = 'running' and claimed_at < now() - interval '2 minutes')
  order by created_at limit 1 for update skip locked)
returning *;
```

Then, outside any transaction: fetch blob, decompress, run the extractor with a 30 s context timeout and panic recovery. Then one short transaction: upsert `records` on `(extractor, canonical_url)`, set derivation `done` with `record_id`. The upsert always widens the seen window (`first_seen_at`, `last_seen_at` from the blob's captures) and replaces `record_hash`, `url_id`, `title`, `search_text` and `data` only when the blob was last seen no earlier than the record, so replaying an older blob never overwrites newer content. NUL is dropped from every string and key in the record's data before it is hashed, since jsonb rejects `\u0000`. On error, including a failed write (`store`): `failed` once `attempts >= 5`, else back to `pending` with `last_error`/`error_class`. `no_match`, `stale` (the page's embedded state belongs to another URL: a single-page app navigated in place, so an extractor checks what it reads against the URL), `unregistered` (a derivation for an extractor or version this binary does not carry) and `timeout` (an extractor cannot be interrupted, so a retry would run beside the copy still going) fail on the first attempt. A stale `running` row that has used its 5 attempts is failed as `abandoned` rather than claimed again. Idle workers sleep 2 s; a successful ingest wakes them through a channel.

`serve`, after migrating, queues every capture under each registered extractor's current version wherever that version has no derivation yet, so neither a version bump nor a migration that clears the derived tables waits on a manual step; the new version's records land on the same `(extractor, canonical_url)` as the old ones. `reprocess` without flags does the same and also deletes the older versions' derivations and the records only they produced, which drops a page a new version no longer reads or keys differently; `--failed` resets failed rows; `--all` deletes the targets' derivations and records and re-queues from `captures`; `--extractor` narrows any of them. Workers in `serve` pick the rows up.

## Extractor interface

```go
type Rule struct {
    Extractor        string   // package name, unique
    Version          int
    Hosts            []string // exact, "*.example.com", or "*" for every host
    PathRegex        string   // RE2 and JS compatible; keep it simple
    ExcludePathRegex string   // pages PathRegex matches that are never captured; RE2 has no lookahead
    QueryKeys        []string // query params that distinguish page views (e.g. "v" on YouTube)
    DwellMS          int      // default 5000; article uses 30000
    Recapture        string   // "never" | "after_change"
    MaxBytes         int      // default 10 MiB
}

type Record struct {
    CanonicalURL string // keys the record with the extractor; normalised by the worker, the page URL when empty
    Title        string
    SearchText   string
    Data         any    // extractor-specific struct, marshalled canonically (sorted keys) for the hash
}

type Extractor interface {
    Rule() Rule
    Extract(ctx context.Context, html []byte, pageURL *url.URL) (Record, error)
}
```

Registry: `extractor.All()` returns every registered extractor; both the rules endpoint and the worker read it. `*.example.com` in `Hosts` matches subdomains only; list the apex separately when it is wanted. `"*"` matches any host: `MatchRule` tries host-specific rules before wildcard ones and `Rules()` publishes wildcards last, so a site extractor always beats the `article` fallback regardless of order, and a host any site rule names never reaches the fallback at all. `ErrNoMatch` marks a page the rule matched but the extractor could not read (login wall, empty shell, under 200 characters of prose for `article`) and is classified `no_match`, not retried. `ErrStale` marks embedded page state that belongs to another URL, which is what a single-page app leaves behind after navigating in place; classified `stale`, not retried.

`article` runs the readeck fork of go-readability over the page and records title, byline, site name, excerpt, published date, language, the cleaned text and a word count; `github` and `x` recapture `after_change`, `youtube` and `article` never.

An article's canonical URL is its `<link rel=canonical>` only when that is on the page's host (a leading `www.` aside) with a path other than `/`, since some sites point every article at their homepage; otherwise it is the page URL.

## HTTP API

All routes on `127.0.0.1:8490`. JSON bodies, `Content-Type: application/json`. A request with an `Origin` header that does not start with `chrome-extension://` gets 403. While no issuer is configured, a request to any route but `/healthz` and `/metrics` whose `Host` is not loopback (`127.0.0.1`, `localhost`, `[::1]`) gets 403 too: a DNS-rebound page is same-origin and sends no `Origin` on a GET. CORS headers allow `chrome-extension://*` and the `Authorization` header.

With an issuer configured, every route below except `/healthz` and `/metrics` needs `Authorization: Bearer <jwt>` and answers 401 without one. 401 is never treated as permanent by a client: the fix is a login, not dropping the data.

Any other 4xx means the request can never succeed as sent, and the extension drops it (except 408 and 429). A 5xx is retried; its body says only `internal server error`, and the error itself goes to the log.

`GET /healthz` → `200 {"ok":true,"db":true}` or 503. Never authenticated.

`GET /metrics` → Prometheus text. Never authenticated.

`GET /v1/capture-rules` → `{"rules":[Rule…]}` with JSON keys `extractor, version, hosts, path_regex, exclude_path_regex, query_keys, dwell_ms, recapture, max_bytes`.

`POST /v1/events/batch`

```json
{
  "device_id": "uuid",
  "events": [
    {
      "type": "page_view",
      "id": "uuid",
      "url": "https://…",
      "title": "…",
      "started_at": "iso",
      "navigation_type": "load",
      "referrer": "https://…",
      "tab_session_id": "…",
      "private": false
    },
    { "type": "span_start", "id": "uuid", "page_view_id": "uuid", "started_at": "iso" },
    {
      "type": "span_start",
      "id": "uuid",
      "started_at": "iso",
      "app_name": "Code",
      "bundle_id": "com.microsoft.VSCode",
      "window_title": "main.go — aqt"
    },
    { "type": "span_heartbeat", "id": "uuid", "at": "iso" },
    { "type": "span_end", "id": "uuid", "ended_at": "iso", "reason": "tab_switch" }
  ]
}
```

A `span_start` carries either `page_view_id` (browser, from the extension) or `app_name` (desktop, from the macOS agent under its own `device_id`), never both; `bundle_id` and `window_title` are optional and only kept with `app_name`. `window_title` is truncated at 512 characters, `app_name` and `bundle_id` at 256. `span_end` reasons: `tab_switch | window_blur | app_switch | window_change | idle | navigation | tab_closed | unknown`; an unknown reason is stored as `unknown`.

Every event is idempotent (upsert by id; heartbeats and ends only move `ended_at` forward, except an `idle` end, which is dated to the last input and may pull `ended_at` back to it, never before `started_at`). A `span_*` whose page view is unknown, a `span_start` with both or neither identity, or any single malformed event, is dropped and counted, not an error; only malformed JSON, a missing `device_id` or more than 1000 events fail the batch with 400. A NUL in a title or any other text field is left out when it is stored (Postgres rejects it in text; bun drops it from every string it formats into a query), never an error. Response `200 {"accepted":n,"dropped":n}`. For a private page view the extension sends `url` as `https://host/` and no title.

`POST /v1/captures` multipart/form-data: part `meta` = `{"capture_id","page_view_id","device_id","captured_at","url","title","extractor","reason","raw_char_count"}`, part `html` = the document. Response above; 422 when `page_view_id` is not on file.

`GET /v1/stats` → table counts, blob sizes and per-status derivation and per-extractor record totals (used by `tracker stats`).

`GET /v1/search?q=…&extractor=…&limit=20` → `{"hits":[{id, extractor, title, canonical_url, snippet, score, last_seen_at, data, visits}]}` (used by `tracker search`). The query goes through `paradedb.match` with fuzzy distance 1 over `title` and `search_text`, never through pg_search's query-string parser, so punctuation and typos are fine; a fuzzy hit gets a locally cut snippet because the engine highlights none.

A visit is a page view, and `visits` always has one shape: `{"count":3,"first_at":"…","last_at":"…","active_seconds":840}`, the first and last page view start (null when `count` is 0) and the summed duration of their activity spans. A record's visits are the page views that captured any of its blobs (`records ← derivations.record_id`, `derivations.raw_hash → captures.page_view_id`) together with the page views at its canonical URL, each counted once. One query in the store counts them for all three routes.

`GET /v1/visits?url=…&before=<rfc3339>` → `{"url":"<normalised>","visits":{…}}`: the page views whose URL normalises to the same `url_hash`, only those started strictly before `before` when it is given (the extension passes the current page view's start, so the answer means "before this visit"). 400 for a missing or non-http(s) `url` or a malformed `before`.

`GET /v1/records/{id}` → `{id, extractor, title, canonical_url, search_text, data, first_seen_at, last_seen_at, visits}` (used by `tracker show`); 404 when no record has the id.

`GET /v1/time?from=<rfc3339>&to=<rfc3339>&by=host|app|category` → `{"rows":[{"key":"github.com","active_seconds":5400}]}`, sorted by `active_seconds` descending (used by `tracker time`): active time per key over the spans of `categorized_spans` clipped to `[from, to)`. Like the dashboard's panels, `host` keys browser spans by host and `app` desktop spans by app name, so each leaves the other source out; `category` covers both, with `uncategorized` for spans no rule matches. `to` defaults to now, `from` to 24 h before `to`, `by` to `host`; 400 for a malformed time, `from` not before `to`, or another `by`.

`POST /v1/forget` with `{"url":"…"}` or `{"host":"example.com"}`, exactly one → `{"page_views":n,"spans":n,"captures":n,"blobs":n,"records":n}` (used by `tracker forget`). The URL is normalised as ingest does; a host is read like an entry of the extension's private-host list (a leading `*.` or a scheme is dropped) and covers its subdomains. One transaction deletes the target's page views with their spans and captures, the blobs and derivations no capture is left for, the records whose canonical URL or page URL is the target or that one of those derivations produced, and the target's `urls` rows; other page views' `referrer_url_id` pointing at it is set null. A deleted record's remaining blobs (HTML another page also captured) get their derivations reset to `pending`, so the worker rebuilds it from what is left, as `reprocess --all` would. `CompleteDerivation` locks its derivation first and writes nothing when the row is gone, so an extraction running during a forget cannot bring the record back. 400 for neither or both, a URL that is not http(s), or a host that is a public suffix (`com`, `co.uk`): one typo would forget every site under it. Backups keep forgotten rows until they rotate out (three daily dumps).

## Extension behaviour

- On install: generate `device_id` (UUIDv7), store in `chrome.storage.local`. Options page: server URL (default above), private hosts list, capture on/off, OIDC issuer and client id.
- **Auth**: none while no issuer is configured. With one, the options page runs an authorization code flow with PKCE through `chrome.identity.launchWebAuthFlow`; the refresh token lives in `chrome.storage.local` and every request refreshes on expiry, once more on a 401. Only `invalid_grant` clears the session, so a network blip never reads as a logout.
- Rules fetched at startup and hourly; cached in storage. No rules cached means no captures, events still flow.
- **Page view**: every top-level navigation (`webNavigation.onCommitted`) and every SPA URL change where the path differs, or a `QueryKeys` value of the matching rule differs (`webNavigation.onHistoryStateUpdated` plus a content-script `pushState`/`replaceState`/`popstate` hook). `navigation_type` from the transition type. Hash-only and unlisted query-only changes are ignored.
- **Spans**: open while the tab is active, its window focused and `chrome.idle` reports `active` (threshold 60 s). Close on tab switch, window blur, idle, navigation, tab close. Heartbeat every 30 s while open. Only one span open per device at a time. Span edges, heartbeats and page view start times carry the time the browser event fired (`webNavigation`'s `timeStamp` where it has one), not the time the service worker got round to handling it.
- **Capture**: when the page view's URL matches a rule and the tab has been active for `dwell_ms`, the service worker asks the content script for `document.documentElement.outerHTML` inside `requestIdleCallback` (`reason: initial`). The content script keeps a `MutationObserver` that sets a dirty flag, cleared by every serialize. A page view whose rule says `recapture: after_change` is captured again (`reason: recapture`) once its last capture is at least 5 minutes old: checked on each heartbeat of its span, and when the span ends while the tab still shows it. A thread that grows while it is read is so stored at most every 5 minutes while it is on screen, and as it was left. A recapture that finds the document unchanged is skipped. A span that ends because its tab navigated or closed leaves no document to recapture; the heartbeat check covers a page left by navigation. The page view remembers `lastCapturedAt` in session storage, which is also what stops a second initial capture. Manual capture from the popup: `reason: manual`, always allowed, and with the `article` fallback it works on any page.
- **Private hosts**: matching page views record host only, no title, `private: true`; never captured. A host added to the list also covers tabs already open on it: their title changes are not sent, and the next page view in the tab gets only its host as referrer. Incognito tabs produce nothing.
- **Outbox**: IndexedDB, one store for events and one for captures. Events batch every 10 s or at 100 pending. Captures upload immediately, but only while no event is queued: the page view a capture references must reach the server first. Retry with backoff up to 5 min. While `/healthz` fails, capture is paused (no HTML serialised); events keep queueing.
- **Popup**: connected/unreachable, pending events, pending captures, last sync, last error, capture-now button, last 100 diagnostic lines.

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
tracker time [--since 24h] [--until when] [--by host|app|category] [--json]
tracker forget <url> | --host <host>
```

`serve` runs migrations on startup, like bank. `blob` writes a stored capture's decompressed HTML to stdout: 64 hex characters name a blob; anything else is a URL, normalised as ingest does, and the most recent capture whose page view is at that URL is written. `stats`, `search`, `show`, `time` and `forget` go over HTTP so they work against a server whose database is not reachable. `search` prints each hit's visits, `show` one record with its full search text. `time`'s `--since` and `--until` take a duration back from now (`90m`, `24h`, `7d`) or a local date, which means its midnight. `login` is the RFC 8628 device code flow, and the token it stores refreshes itself.

## Metrics

Counters: `tracker_http_requests_total{route,status}`, `tracker_events_ingested_total{type}`, `tracker_events_dropped_total{type}`, `tracker_captures_ingested_total{extractor,dedup}`, `tracker_capture_raw_bytes_total`, `tracker_capture_stored_bytes_total`, `tracker_derivations_total{extractor,result}`, `tracker_records_total{extractor,dedup}`. Histograms: `tracker_http_request_duration_seconds{route}`, `tracker_extract_duration_seconds{extractor}`. Gauges: `tracker_derivations_pending`, `tracker_derivations_oldest_age_seconds`, `tracker_table_bytes{table}`. Labels stay bounded: never a URL or host.

## Milestones

1. Schema, store, ingest server, worker, CLI, compose. Fake extractor for tests.
2. Extension: page views, spans, rules, capture, outbox, popup.
3. Extractors: github, x, youtube, article, each with fixture HTML tests.
4. Grafana dashboard: attention per host per day, captures and dedup, queue depth.
5. Recapture of pages that change while open; desktop agent, categories, work blocks and context-switch panels.
