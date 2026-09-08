# tracker — browsing memory

What I read and where my attention went, from a browser extension into a local Postgres. Two products of equal weight: **recall** (search over structured records extracted from pages I read) and **attention analytics** (page views and active time per site). Visits are cheap events; HTML snapshots are content-addressed immutable blobs; extraction is asynchronous, idempotent and replayable.

## Decisions (locked 2026-09-08)

| Area          | Choice                                                                             | Why                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Go, single `tracker` binary; `serve` runs HTTP plus in-process workers             | One process to supervise per machine                                                                                                                                      |
| Store         | Postgres via the ParadeDB image (`pg_search` BM25)                                 | Same search engine as bank; no second index to sync                                                                                                                       |
| Location      | Localhost per machine, `127.0.0.1` only                                            | Privacy first; `device_id` + UUIDv7 everywhere keep a later merge a `UNION`                                                                                               |
| Auth          | None on loopback                                                                   | Owner's decision. Requests carrying an `Origin` header that is not `chrome-extension://…` are rejected anyway, which costs nothing and blocks forged posts from web pages |
| Capture scope | Allowlist by extractor rule; the server publishes rules, the extension caches them | Only pages an extractor can read are worth a blob; the browser stays cheap                                                                                                |
| Extraction    | Per-site extractors in Go returning typed records, run server-side                 | Serialising `outerHTML` is the cheapest thing the browser can do                                                                                                          |
| Raw HTML      | Kept forever, zstd in Go, `STORAGE EXTERNAL`                                       | Re-running a fixed extractor after a site changes markup is the whole reason to keep it                                                                                   |
| Queue         | The derivation row is the job (`FOR UPDATE SKIP LOCKED`)                           | Identity `(raw_hash, extractor, version)` already exists; no PGMQ                                                                                                         |
| Dedup         | Blob hash, then record hash over canonical JSON                                    | SimHash dropped: structured records have no prose to near-match                                                                                                           |
| ORM           | uptrace/bun with `pgdriver`, SQL migrations embedded                               | SQL-first with struct scanning; raw SQL where `@@@`, `SKIP LOCKED` and `ON CONFLICT` need it                                                                              |
| Observability | slog JSON, Prometheus `/metrics`, Grafana with Postgres datasource for analytics   | Metrics yes, tracing no; analytics dashboards come free from the Postgres datasource, so no web app in v1                                                                 |
| Extension     | WXT, TypeScript, Chromium MV3 only                                                 | One background lifecycle to get right                                                                                                                                     |

## Layout

```
apps/tracker/
  cmd/tracker/            serve | migrate | reprocess | stats | search
  internal/
    store/                bun models, embedded migrations, queries
    ingest/               HTTP: events, captures, capture-rules, healthz, metrics
    extractor/            Extractor interface, Rule, registry
    extractor/github/     one package per site
    extractor/x/
    extractor/youtube/
    processor/            worker loop: claim derivation, decompress, extract, write record
    urlnorm/              normalisation + hash
    blob/                 blake3 + zstd
    metrics/              Prometheus collectors
  extension/              WXT extension (@aqt/tracker-extension)
  deploy/
    docker-compose.yml    ParadeDB, Prometheus, Grafana
    prometheus.yml
    grafana/provisioning/ datasources (Prometheus, Postgres) + dashboards
  README.md, DESIGN.md
```

## Ports and env

| What          | Value                                          |
| ------------- | ---------------------------------------------- |
| Postgres      | `127.0.0.1:5434`, db `tracker`, user `tracker` |
| tracker serve | `127.0.0.1:8490`                               |
| Prometheus    | `127.0.0.1:9091`                               |
| Grafana       | `127.0.0.1:3090`                               |

Env: `TRACKER_DATABASE_URL` (default `postgres://tracker:tracker@127.0.0.1:5434/tracker?sslmode=disable`), `TRACKER_LISTEN` (default `127.0.0.1:8490`), `TRACKER_WORKERS` (default 3), `TRACKER_LOG_LEVEL`.

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
  page_view_id  uuid not null references page_views,
  started_at    timestamptz not null,
  ended_at      timestamptz not null,           -- advanced by heartbeats
  end_reason    text,                           -- null while open; tab_switch | window_blur | idle | navigation | tab_closed | unknown
  created_at    timestamptz not null default now()
);
create index on activity_spans (device_id, started_at desc);
create index on activity_spans (page_view_id);

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
  error_class       text,                       -- panic | parse | no_match | timeout | too_large | unregistered
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
  record_hash   bytea not null,                 -- blake3(canonical json of data)
  url_id        bigint not null references urls,
  canonical_url text,
  title         text,
  search_text   text not null,                  -- what BM25 sees; built by the extractor
  data          jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  unique (extractor, record_hash)
);
create index records_search on records using bm25 (id, title, search_text, extractor)
  with (key_field = 'id');
```

Source data: `urls`, `page_views`, `activity_spans`, `raw_html_blobs`, `captures`. Derived: `derivations`, `records`. `tracker reprocess --all` must rebuild the derived tables from source alone; that property has a test.

## Ingest transaction for a capture

1. Read multipart: `meta` (JSON) and `html` (text/html). Reject over 25 MiB before buffering; reject over the rule's `max_bytes` with 413.
2. `hash = blake3(html)`, `payload = zstd(html, level 3)`.
3. One transaction: upsert `urls`; `INSERT raw_html_blobs ON CONFLICT DO NOTHING`; `INSERT captures`; `INSERT derivations (hash, extractor, current version, pending) ON CONFLICT DO NOTHING`.
4. Respond `201 {capture_id, raw_hash (hex), deduplicated: bool}`. On any failure respond 5xx with nothing written; the extension keeps the capture in its outbox.

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

Then, outside any transaction: fetch blob, decompress, run the extractor with a 30 s context timeout and panic recovery. Then one short transaction: upsert `records` on `(extractor, record_hash)` (bump `last_seen_at`), set derivation `done` with `record_id`. On error: `failed` once `attempts >= 5`, else back to `pending` with `last_error`/`error_class`. `no_match` and `unregistered` (a derivation for an extractor or version this binary does not carry) fail on the first attempt. Idle workers sleep 2 s; a successful ingest wakes them through a channel.

`reprocess` without flags queues every capture under each extractor's current version (the rollout after a version bump); `--failed` resets failed rows; `--all` deletes the targets' derivations and records and re-queues from `captures`; `--extractor` narrows any of them. Workers in `serve` pick the rows up.

## Extractor interface

```go
type Rule struct {
    Extractor string   // package name, unique
    Version   int
    Hosts     []string // exact, or "*.example.com"
    PathRegex string   // RE2 and JS compatible; keep it simple
    QueryKeys []string // query params that distinguish page views (e.g. "v" on YouTube)
    DwellMS   int      // default 5000
    Recapture string   // "never" | "after_quiet"
    MaxBytes  int      // default 10 MiB
}

type Record struct {
    CanonicalURL string
    Title        string
    SearchText   string
    Data         any    // extractor-specific struct, marshalled canonically (sorted keys) for the hash
}

type Extractor interface {
    Rule() Rule
    Extract(ctx context.Context, html []byte, pageURL *url.URL) (Record, error)
}
```

Registry: `extractor.All()` returns every registered extractor; both the rules endpoint and the worker read it. `*.example.com` in `Hosts` matches subdomains only; list the apex separately when it is wanted. `ErrNoMatch` marks a page the rule matched but the extractor could not read (login wall, empty shell) and is classified `no_match`, not retried.

## HTTP API

All routes on `127.0.0.1:8490`. JSON bodies, `Content-Type: application/json`. A request with an `Origin` header that does not start with `chrome-extension://` gets 403. CORS headers allow `chrome-extension://*`.

`GET /healthz` → `200 {"ok":true,"db":true}` or 503.

`GET /metrics` → Prometheus text.

`GET /v1/capture-rules` → `{"rules":[Rule…]}` with JSON keys `extractor, version, hosts, path_regex, query_keys, dwell_ms, recapture, max_bytes`.

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
    { "type": "span_heartbeat", "id": "uuid", "at": "iso" },
    { "type": "span_end", "id": "uuid", "ended_at": "iso", "reason": "tab_switch" }
  ]
}
```

Every event is idempotent (upsert by id; heartbeats and ends only move `ended_at` forward). A `span_*` whose page view is unknown, or any single malformed event, is dropped and counted, not an error; only malformed JSON, a missing `device_id` or more than 1000 events fail the batch with 400. Response `200 {"accepted":n,"dropped":n}`. For a private page view the extension sends `url` as `https://host/` and no title.

`POST /v1/captures` multipart/form-data: part `meta` = `{"capture_id","page_view_id","device_id","captured_at","url","title","extractor","reason","raw_char_count"}`, part `html` = the document. Response above.

`GET /v1/search?q=…&extractor=…&limit=20` → `{"hits":[{id, extractor, title, canonical_url, snippet, score, last_seen_at, data}]}` (used by `tracker search`). The query goes through `paradedb.match` with fuzzy distance 1 over `title` and `search_text`, never through pg_search's query-string parser, so punctuation and typos are fine; a fuzzy hit gets a locally cut snippet because the engine highlights none.

## Extension behaviour

- On install: generate `device_id` (UUIDv7), store in `chrome.storage.local`. Options page: server URL (default above), private hosts list, capture on/off.
- Rules fetched at startup and hourly; cached in storage. No rules cached means no captures, events still flow.
- **Page view**: every top-level navigation (`webNavigation.onCommitted`) and every SPA URL change where the path differs, or a `QueryKeys` value of the matching rule differs (`webNavigation.onHistoryStateUpdated` plus a content-script `pushState`/`replaceState`/`popstate` hook). `navigation_type` from the transition type. Hash-only and unlisted query-only changes are ignored.
- **Spans**: open while the tab is active, its window focused and `chrome.idle` reports `active` (threshold 60 s). Close on tab switch, window blur, idle, navigation, tab close. Heartbeat every 30 s while open. Only one span open per device at a time.
- **Capture**: when the page view's URL matches a rule and the tab has been active for `dwell_ms`, the service worker asks the content script for `document.documentElement.outerHTML` inside `requestIdleCallback`; once per page view (`reason: initial`). The content script keeps a `MutationObserver` that only sets a dirty flag; nothing acts on it in v1. Manual capture from the popup: `reason: manual`, always allowed.
- **Private hosts**: matching page views record host only, no title, `private: true`; never captured. Incognito tabs produce nothing.
- **Outbox**: IndexedDB, one store for events and one for captures. Events batch every 10 s or at 100 pending. Captures upload immediately. Retry with backoff up to 5 min. While `/healthz` fails, capture is paused (no HTML serialised); events keep queueing.
- **Popup**: connected/unreachable, pending events, pending captures, last sync, last error, capture-now button, last 100 diagnostic lines.

## CLI

```
tracker serve [--listen 127.0.0.1:8490] [--workers 3]
tracker migrate
tracker reprocess [--extractor name] [--failed] [--all]
tracker stats [--json]
tracker search [--extractor name] [--limit n] [--json] <query>
```

`serve` runs migrations on startup, like bank.

## Metrics

Counters: `tracker_http_requests_total{route,status}`, `tracker_events_ingested_total{type}`, `tracker_events_dropped_total{type}`, `tracker_captures_ingested_total{extractor,dedup}`, `tracker_capture_raw_bytes_total`, `tracker_capture_stored_bytes_total`, `tracker_derivations_total{extractor,result}`, `tracker_records_total{extractor,dedup}`. Histograms: `tracker_http_request_duration_seconds{route}`, `tracker_extract_duration_seconds{extractor}`. Gauges: `tracker_derivations_pending`, `tracker_derivations_oldest_age_seconds`, `tracker_table_bytes{table}`. Labels stay bounded: never a URL or host.

## Milestones

1. Schema, store, ingest server, worker, CLI, compose. Fake extractor for tests.
2. Extension: page views, spans, rules, capture, outbox, popup.
3. Extractors: github, x, youtube, each with fixture HTML tests.
4. Grafana dashboard: attention per host per day, captures and dedup, queue depth.
