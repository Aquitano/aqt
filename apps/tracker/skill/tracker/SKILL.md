---
name: tracker
description: Recall and attention over the owner's own browsing and screen time, through the `tracker` CLI. A browser extension records every page he opens and how long it held focus, snapshots the pages he reads (articles, GitHub issues and pull requests, X threads, YouTube videos) into searchable records, and a desktop agent records which app had focus. Use whenever a task needs something he read or watched, or how he spent his time. Trigger on requests like "what was that article/thread/video/issue I read about X", "have I seen this page before", "when did I last look at …", "how long did I spend on X today/this week", "what was I working on yesterday", "which sites ate my afternoon".
---

# tracker — the owner's browsing memory

One local Postgres holding page views, active time and the structured text of pages he read, searchable from the CLI. Read freely; the one write, `forget`, only on his explicit word.

## Preflight

Run once before the first tracker command in a session:

```sh
command -v tracker
tracker stats
```

`tracker stats` is the cheapest end-to-end check: if it prints counts, everything works. Each failure means stop and report rather than retry:

- `command -v tracker` prints nothing: the binary is not installed, or `~/.local/bin` is not on `PATH`. Report it; do not build or install it.
- `dial tcp 127.0.0.1:8490: connect: connection refused`: `tracker serve` is not running. Usually Docker Desktop has not started, and the server exits without Postgres until it does (launchd retries every 30 s). The owner starts Docker; `mise run tracker:logs` shows the server's side.
- `HTTP 500 internal server error`: the server is up but its database is not answering. Same cause, same fix.
- `no stored token: run 'tracker login'`, or `invalid or missing bearer token (run 'tracker login')`: authentication is on and there is no valid session. Login is a device-code flow a person approves, so ask the owner to run `tracker login`.
- `HTTP 403 authentication is off, so only loopback hosts are served`: `TRACKER_SERVER_URL` names something other than `127.0.0.1` or `localhost`.

`stats` also says what is in there: a `records <extractor>` line per site with records, and `derivations pending`, the pages captured but not yet extracted. A just-read page is searchable once its derivation is done, usually within seconds.

## Finding what he read

```sh
tracker search [--extractor name] [--limit n] [--json] <query>   # BM25 over extracted records
tracker show [--json] <record-id>                                # one record in full
tracker visits [--json] <url>                                    # any page's visits, captured or not
tracker blob <hash-or-url>                                       # raw HTML of a capture, to stdout
```

Flags go before the positional argument: Go's flag parsing stops at the first word, so `tracker search vacuum --json` searches for "vacuum --json" and prints text. Always pass `--json` when consuming the output.

- Search ranks title and extracted text with BM25. Each word matches within one typo and words match independently, more of them ranking higher; there is no phrase, all-words or date filter, so search with the distinctive words and read the dates off the hits. The URL is not indexed: search for words on the page, not its domain.
- `--extractor` narrows to one site's records: `github` (issues and pull requests with their comments), `x` (a post with the thread around it), `youtube`, `article` (readable prose of any other site), plus any newer extractor `tracker stats` lists. `--limit` defaults to 20, maximum 100.
- A hit carries `id`, `extractor`, `title`, `canonical_url`, `snippet` (plain text around the match), `score`, `last_seen_at`, `data` (the extractor's structured fields: comments, author, channel, byline and the like) and `visits`.
- `visits` is `{count, first_at, last_at, active_seconds}`: how many page views opened the page (any that captured it or were at its canonical URL), the first and last time it was opened, and the focused time over all of them. `last_at` answers "when did I last look at it"; `last_seen_at` is only when its content was last captured. `active_seconds` is focused time, not time the tab sat open.
- `tracker show --json <id>` adds the full `search_text`, which `search` cuts to a snippet. Read the record rather than guessing from the snippet.
- `tracker visits <url>` answers "have I seen this page before" for any URL, including pages that were never captured because he left before the 5 s or 30 s dwell. The URL is normalised like ingest does, so tracking parameters and fragments do not matter. Quote it: the shell globs `?`. A private host's page views are all stored at `https://<host>/`, so ask for that URL there.
- `tracker blob` writes the stored HTML of a capture: a 64-hex blob hash, or a URL for its most recent capture. Reach for it only when a record lacks something the page had, such as an image URL or a field the extractor drops; write it to a file under a temp directory and search the file rather than reading megabytes of markup. It needs the database, so it only works on the machine running the server.

```sh
# "what was that article about Postgres vacuum I read"
tracker search --json "postgres vacuum autovacuum"
tracker show --json 1234

# "the GitHub issue where someone explained the bun migration lock"
tracker search --extractor github --limit 50 --json "migration lock advisory"

# "have I read this before"
tracker visits --json 'https://example.com/post?id=7'
```

## Where the time went

```sh
tracker time [--since 24h] [--until when] [--by host|app|category] [--json]
```

Active time per key, each span clipped to the window. `--since` and `--until` take a duration back from now (`90m`, `24h`, `7d`) or a local date meaning its midnight (`2026-10-01`); the window defaults to the last 24 hours. Today is `--since <today's date>`; yesterday is `--since <yesterday> --until <today>`.

- `--by host` is browser time per site, `--by app` desktop time per app, `--by category` both together (`Focus/Code`, `Communication`, `Distraction`, `Learning`, `AI`, `Browsing`, ...; `uncategorized` when no rule matches). Chromium browsers are not tracked as apps, since the extension already counts that time per site, so browser hours show up only under `host` and `category`.
- "What was I working on" is `--by category` for the shape of the day, then `--by app` and `--by host` for the detail, then `search` for the pages behind a host. The CLI does not show window titles or work blocks; the Grafana dashboard at <http://127.0.0.1:3090> has the work blocks.

## What is and is not recorded

- Recorded: every page opened in the Chromium browser with the extension, and its focused time (tab and window focused, not idle). Pages on sites with an extractor are snapshotted after 5 s of focus; any other page after 30 s, by the `article` fallback. With the desktop agent, the frontmost app and its window title.
- Never recorded: incognito tabs. Hosts on the extension's private list keep the host and nothing else: no path, title or HTML, so their visits and time exist under the host alone. Apps on the agent's private list (password managers) keep the app name without window titles. Nothing beyond the window title is read from a desktop app; Safari and Firefox show up as apps with window titles only.
- Absence is not proof: a page left before its dwell has a page view but no record (use `visits`), the extension's pause button stops the clock, and while the server was unreachable nothing was captured.

## Forgetting

`tracker forget <url>` and `tracker forget --host <host>` delete everything recorded for a page, or a host and all its subdomains: page views, time, snapshots and records, permanently. Run it only when the owner explicitly asks to forget a specific page or site, never to tidy up, test or undo something else. Say the exact target and that it cannot be undone, prefer the URL form when he means one page, and quote the URL. The daily backups keep the data until they rotate out (three dumps), so mention that if he expects it gone everywhere.
