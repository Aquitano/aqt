# tracker

Browsing memory: a Chromium extension records page views and active time, and snapshots the HTML of pages an extractor can read; a local Go server turns those snapshots into searchable structured records in Postgres. Two products of equal weight — recall over what I read, and attention analytics over where the time went. See [DESIGN.md](DESIGN.md) for the architecture.

## Quickstart

```sh
docker compose -f deploy/docker-compose.yml up -d   # ParadeDB, Prometheus, Grafana
go run ./cmd/tracker serve                          # migrates on startup
```

Load the extension unpacked in `chrome://extensions` (developer mode) from `extension/.output/chrome-mv3`, built with `bun run --filter @aqt/tracker-extension dev`.

Grafana is at <http://127.0.0.1:3090> — anonymous admin, dashboard `tracker`, both datasources provisioned.

## CLI

```
tracker serve [--listen 127.0.0.1:8490] [--workers 3]
tracker migrate
tracker reprocess [--extractor name] [--failed] [--all]
tracker stats [--json]
tracker search [--extractor name] [--limit n] [--json] <query>
```

`reprocess --all` rebuilds every derived row from the source tables alone.

## Ports

| What            | Address                             |
| --------------- | ----------------------------------- |
| Postgres        | `127.0.0.1:5434`, db/user `tracker` |
| `tracker serve` | `127.0.0.1:8490`                    |
| Prometheus      | `127.0.0.1:9091`                    |
| Grafana         | `127.0.0.1:3090`                    |

Everything is loopback-only and unauthenticated by design; requests carrying an `Origin` that is not `chrome-extension://…` are rejected.

## What is recorded

Every top-level navigation and SPA URL change as a page view, active time as spans (tab focused, window focused, not idle), and the full HTML of pages matching a capture rule. Raw HTML is kept forever, zstd-compressed and content-addressed, so a fixed extractor can be replayed over it.

Never recorded: anything from an incognito tab, and the title or HTML of a host on the private list — those page views keep the host and nothing else. Capture pauses entirely while the server is unreachable.

Config via env, see [.env.example](.env.example).
