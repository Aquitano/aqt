# aqt-bank architecture

Bank stores correspondence, a personal media library, activity, collections, files, and published Markdown pages, and catalogues the files on disks that come and go. The CLI and web UI search these records together. The library contracts and ownership rules are documented in [LIBRARY.md](LIBRARY.md); the catalogue of disks, its identities and its commands in [DISKS.md](DISKS.md).

## Decisions (locked 2026-08-17)

| Area          | Choice                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Go, single `bank` binary                                                                                                                                                       | Static binary on the VPS, easy cron, no runtime to babysit                                                                                                                                                                                                                          |
| Store         | Postgres + ParadeDB `pg_search`                                                                                                                                                | One system of record; BM25 ranking + fuzzy/typo tolerance in-database, no sync pipeline to a second search engine                                                                                                                                                                   |
| Hosting       | VPS, LUKS-encrypted data volume, restic encrypted backups, everything in containers                                                                                            | Accepts that a running box is readable by the provider; protects disks at rest and backups. The server runs non-root on a read-only rootfs from a distroless image with no shell, so a bug in the process that serves the archive over a network port reaches as little as possible |
| Sync model    | Pull-based: `bank serve` schedules the Gmail sync and the inbox sweep as jobs; `bank imap` polls configured IMAP folders; manual sources land in an inbox dir                  | Gmail sync runs on the archive host. The optional IMAP daemon runs beside Proton Bridge or another IMAP endpoint, keeps local SQLite checkpoints, and uploads through the existing import API. The optional OCR worker works the ocr job queue.                                     |
| Interface     | CLI, `--json` on every read command                                                                                                                                            | Humans get text, agents get JSON; MCP wrapper can come later                                                                                                                                                                                                                        |
| Remote access | `bank serve` in the same binary, the CLI always calls its API: over HTTP when `BANK_URL` is set, in process otherwise; bearer tokens hashed in `$BANK_DATA_DIR/tokens`, no TLS | A laptop CLI against a remote `DATABASE_URL` writes blobs and raw inputs locally while rows go to the VPS, a split brain. One binary means no second artifact to build or deploy; Tailscale is the transport security, so the server only needs authentication                      |
| Scope         | Full history, all attachments                                                                                                                                                  | Attachments are content-addressed (BLAKE3) so duplicates are free                                                                                                                                                                                                                   |

## Source acquisition

| Source        | Method                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Automation                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Gmail         | Gmail API, incremental via `historyId`; initial backfill via full list                                                                                                                                                                                                                                                                                                                                                                                        | hourly job in `bank serve`                                |
| ProtonMail    | official `proton-mail-export` CLI (paid plan) dumping EML into the inbox dir                                                                                                                                                                                                                                                                                                                                                                                  | cron                                                      |
| Discord       | GDPR data package ("Request my data"), dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                     | manual, ~quarterly                                        |
| LinkedIn      | official data export CSV, dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                                  | manual, ~quarterly                                        |
| WhatsApp      | per-chat "Export chat" zips from the phone, dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                | manual                                                    |
| YouTube       | Google Takeout, "YouTube and YouTube Music" → history (`watch-history.html` by default, `watch-history.json` when the export is set to "Multiple formats" — prefer JSON: HTML timestamps are localized, and a layout the parser does not know skips the record); not in the Data API, so Takeout is the only route. Watch history only — search history is a log of two-word queries that would dilute BM25 for common words while adding nothing retrievable | scheduled Takeout export into Drive, swept into the inbox |
| ChatGPT       | official data export zip (conversations.json or numbered shards, message tree incl. regenerated branches)                                                                                                                                                                                                                                                                                                                                                     | manual, on demand                                         |
| Claude.ai     | official data export zip (conversations.json)                                                                                                                                                                                                                                                                                                                                                                                                                 | manual, on demand                                         |
| anything else | `bank import json` — JSON array or NDJSON on stdin/file                                                                                                                                                                                                                                                                                                                                                                                                       | agents, scripts                                           |

Deliberately inside ToS everywhere. If WhatsApp manual export gets old, the escape hatches are (a) one-shot Android backup decrypt (`wa-crypt-tools`) for deep backfill, (b) a whatsmeow linked-device bridge for live capture — both documented here so the schema already fits them.

## Data model

Correspondence normalizes to `messages`. Source-specific detail stays in the stored raw inputs. Media and personal tracking use separate typed tables. Their search projections do not change message identities or citations.

- `raw_inputs(id, kind, content_id, name, options, received_at, finished_at, status, report, error)`, unique on `(kind, content_id, name, options)`. Every input is stored in the blob store and recorded here before it is parsed: a CLI file or directory, an upload, an inbox file, a Gmail-synced or IMAP-collected message, and a `bank library index` publication. `options` holds the kind's typed options, which are the flags of `bank import <kind>`. `status` is `running`, `complete`, `gaps` or `failed`, and `report` holds the latest import's report. Importing the same input again reruns its row and replaces the report. `bank reimport [kind...]` reads this table in id order through today's sources.
- `messages(id, ref, source, external_id, thread_id, sender, recipients[], subject, body, sent_at, sort_at, participants[], raw_input_id, raw_locator, ingested_at)`
  - `participants` is generated from the sender and recipients: every identity key of each (the whole value, the bracketed address and the display name, folded), once as it is and once after the source and a unit separator. A contact alias that matches everywhere is compared with the first form, one scoped to a source with the second, so "is this message Alice's" is one array overlap that a GIN index answers for contact history and browse, and a term set inside the BM25 index for search. It replaced a regular expression evaluated per row and per recipient. A table of participants would answer the same with a join per filter and rows to keep in step with every message write; the generated array cannot drift.
  - `raw_input_id` names the raw input the message was read from, and `raw_locator` says where inside it, such as `message 12`, `entry 4` or a conversation in `conversations.json`.
  - `sent_at` is null when the source gives no date. The generated `sort_at = coalesce(sent_at, '-infinity')` drives every ordering and page cursor, so an undated message sorts before every dated one. Date filters and the timeline leave it out.
  - `unique (source, external_id)` makes every importer idempotent — re-importing a dump is always safe.
  - Sources without stable IDs derive one: WhatsApp from `sha256(thread|sent_at|sender|body)`, YouTube from `sha256(video|second watched)`, falling back to the title for a record whose export names no video — overlapping Takeout exports of the same watch collapse, a second watch of the same video does not. Which URL forms yield a video id therefore decides identity, not just parsing.
  - Citations use `ref`, never `id`. `id` is a row serial that rebuilding the archive reassigns, so it stays inside the server for joins and no route, flag or JSON field exposes it. The ref is `msg:` and the first 16 hex characters of `sha256(source || 0x00 || field || 0x00 || value)`, where `field` is `message_id` and `value` the RFC 822 Message-ID when the message has one, and otherwise `external_id` and the source's external id. Hashing which field was used keeps an external id that spells some mail's Message-ID from sharing its ref. `ref.ForMessage` computes it once, at insert, into a `unique` column. A different message whose ref is already taken fails the import instead of being skipped as a duplicate, and a lookup by ref reads the unique index.
  - `thread_id` is the source's own conversation id wherever there is one — ChatGPT `conversation_id`, Claude.ai `uuid`, a Discord channel id — and the human title lives in `subject`. Titles repeat ("New chat", a #general on every server) and get renamed, so keying threads on them merged unrelated conversations and split renamed ones.
- `contents(id, blake3, size_bytes)` — the one identity bytes have, shared with the catalogue of files on disks. A message attachment, a library file and a file on a disk with the same bytes point at one row.
- `attachments(message_id, position, filename, mime_type, content_id)`, keyed on `(message_id, position)`. `position` is the attachment's place in the record the source read, so a repeated or concurrent import writes each attachment once, and a later, fuller export adds the missing ones at their positions. The bytes live in the blob store, not the database.
- `texts(content_id, status, extractor, detail, text, chars)` — text read out of attachments, library files and disk files, keyed on content so a document attached to forty messages, or already read by a disk scan, is extracted and indexed once. Text longer than the cap is cut and stored as `truncated`; `manual` text is never overwritten by an extractor. Search finds a document by its text in this one index and joins it to the messages, library files and disk entries that hold it when it builds the hit, so storing text rewrites no message.
- `contacts(id, name, note, self)` + `contact_aliases(contact_id, source, value, value_norm)` — one person, many source-specific identities. `self` marks the archive's owner, whom browse leaves out of a thread's members; at most one contact has it. Aliases are attached by hand and match everywhere unless scoped to a source; nothing merges automatically, so a wrong attachment is undone by detaching it and the identity each source recorded is never rewritten.
- `message_tombstones(source, external_id, message_id, ref, …, raw_input_id, replacement, retired_at)` holds the rows `bank retire` deleted. Imports skip a tombstoned `(source, external_id)` and, for mail, a tombstoned `(source, message_id)`: mail ingest matches a Message-ID before an external id, so a retired mail can come back from another export under a new external id. `bank show` resolves a tombstoned ref to the tombstone, whose `ref` is unique like the message's was.
- Search is pg_search BM25 everywhere; the README's [Search](README.md#search) section has the grammar and the hit shape. The messages index holds `subject` and `body` with the prose tokenizer, `sender` and `recipients` with the name tokenizer, and `source`, `thread_id`, `participants`, `sent_at` and `sort_at` as filter fields, so a filtered search is answered by the index's top-N scan. Messages are ordered by score, then `sort_at`, then `id`; the id makes it a total order, so a page means the same thing twice. A typo-tolerant match carries a tenth of an exact word's boost, because pg_search scores a fuzzy match as a constant larger than most BM25 scores, and a subject counts three times. Snippets come from `paradedb.snippet`, with a window cut from the start of the body as the fallback, since the engine highlights no fuzzy match. Each kind's list is fused with the others by reciprocal rank fusion: the ranks of different indexes are comparable where their scores are not. Paging is `--offset`, capped at 10000.
- Library records are ranked in BM25 indexes keyed on a `seq` column, because pg_search selects a top-N page only when every tie-break is a number or a byte-ordered literal, and the text ids are neither. An item's index also holds the notes and tags of its personal state, copied onto the item when the state changes, so every word of a query can match in either. Library dates are real columns, `occurred_at` with `occurred_precision` and likewise for snapshots and entries: an instant in UTC to the microsecond, or a day as its UTC midnight. The importers write them, filters and the timeline compare them, and `bank_library_date` writes them back in the API's `{value, precision}` shape.

Thread pages are ordered by `(sort_at, id)` and take a message ref as the cursor, scoped by source and thread ID. `--around` centers a page on a search hit; `--before`, `--after`, and `--latest` reach the rest of the history. The browser uses `GET /v1/threads` for typed conversation summaries instead of assembling SQL.

Email retrieval adds typed, rebuildable projections rather than a general metadata bag. `mailboxes` and `mailbox_messages` record exact historical folder observations. `mail_details`, source-scoped `mail_thread_nodes`, and message-owned `mail_thread_edges` retain bounded reply-header evidence. Multiple canonical rows can share a normalized RFC node without changing deduplication or citations. Metadata writes take a source advisory lock and commit membership, graph facts, thread IDs, and aliases together.

Provider thread IDs remain authoritative. Generic mail uses deterministic derived IDs, with `mail_thread_aliases` preserving earlier derived lookups. Contradictory provider anchors produce explicit conflict records and separate unanchored messages. Generic branch fields are not used for email relationships. Historical parsing runs only through the explicit `bank mail rebuild` command, with destination-side `mail_rebuild_progress` checkpoints. See [MAIL.md](MAIL.md) for limits and recovery behavior.

## Filesystem layout (`$BANK_DATA_DIR`, default `~/.local/share/aqt-bank`)

```
blobs/ab/abcdef…        content-addressed attachments, library files and raw inputs (BLAKE3, two-char fan-out)
inbox/<kind>/           drop zone for manual exports; `bank import inbox` sweeps supported import kinds
inbox/.done/<kind>/     processed exports, including duplicates
inbox/.rejected/<kind>/ exports the importer could not read; operational failures stay in the drop zone
tmp/                    extraction staging
```

The `youtube` and `youtube-media` importers store the whole Takeout they are given as the raw input, not only the history file, so a full Takeout can take gigabytes.

## CLI

```
bank import whatsapp <file.zip|.txt>…   # per-source explicit import
bank import youtube <takeout.zip|dir>   # YouTube watch history (Takeout)
bank import inbox                       # sweep the inbox drop zone
bank sync                               # pull deltas from API sources (Gmail)
bank search 'words "a phrase"' [--kind k] [--source s] [--thread id] [--from alice]
                    [--to bob] [--person alice] [--since 2024-01-01] [--until d] [--any]
                    [--limit 1..500] [--offset 0..10000] [--json]
bank search [--source s] [--person alice] [--after msg:ref]   # browse conversations
bank contact add|rm|list|show <name>    # one person across their many identities
bank contact alias add|rm <name> <email|handle|source:name>...
bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--offset n] [--json]
bank contact suggest [--limit n]        # identities in the archive no contact claims yet
bank contact self <name>                # mark the owner, whom browse leaves out of members
bank contact import <file|-> [--json]   # a whole contact book at once (JSON array or NDJSON)
bank thread <id> [--source s] [--limit n] [--json]   # a page of the conversation, oldest first
bank thread <id> --source s --around <msg:ref>      # context centered on a message
bank thread <id> --source s --before <msg:ref>      # the preceding page
bank thread <id> --source s --after <msg:ref>       # the following page
bank show <ref> [--json]                # any cited record, and where the same bytes are
bank show <content:ref> --text|--metadata  # what was read from the bytes, attached or on a disk
bank stats [--json]                     # counts, date ranges, last import, last sync, notes, disks
bank note <source> <text>               # note what a source holds (empty text clears)
bank fetch <blake3> [-o path]           # write an attachment to a file
bank verify [--json]                    # hash every content the database names; repairs nothing
bank reimport [kind...]                 # replay stored raw inputs through today's sources
bank reports [--before id] [--json]     # raw inputs, newest first, with their latest report
bank retire --source s --external-prefix p… [--replacement-map f] [--reason r] [--apply]
                                        # delete messages by prefix, leaving tombstones (dry run by default)
bank serve [--listen addr]              # HTTP API (default 127.0.0.1:8480), default job queue, schedule
bank worker [--queue ocr]               # work one job queue in another process
bank token new|list|revoke <name>       # bearer tokens for bank serve
bank disk scan|search|entry|get|verify|enrich|analysis|volumes|scans|skips|dupes|redundancy
bank disk dedupe plan|apply, bank disk organize prepare|apply|undo, bank disk config
                                        # on the machine the disks attach to; see DISKS.md
```

Every command that has an API operation calls it through `internal/client`. With `BANK_URL` (and `BANK_TOKEN`) set, the client talks to that `bank serve`. Without it, the CLI builds the server's handler in process from `DATABASE_URL` and `BANK_DATA_DIR` and the client calls it through an `http.RoundTripper`: no socket, no token, no job workers or schedule, and opening the database checks the schema version without migrating. Flags, validation, defaults, errors and output are the same in both, because both run the same handlers.

An operation is declared once, as an `httpapi.Op[Input, Output]` value in `internal/server` (or `internal/attic/api` for the catalogue below `/v1/disk`). The server registers its handler with that value and the client calls `client.Call(ctx, c, server.GetMessage, server.MessageInput{...})` with it, so method and path come from one place and the compiler ties the input and output types to both. The client encodes the input from the same struct tags Huma decodes it with.

`auth`, `sync`, `migrate`, `serve`, `worker`, `token`, `verify`, `retire`, `reimport`, `import inbox` and `mail rebuild` administer the box itself and work on the archive, the blob store or the token file directly. All of them except `auth` and `serve` refuse outright when `BANK_URL` is set. Acting on the wrong box is the split brain the Decisions table's "Remote access" row exists to prevent, and the CLI should not need the operator to remember which side a command belongs on. `imap` and `ui` need `BANK_URL`, `healthcheck` takes a URL, and `openapi` needs nothing.

Migrations are embedded in the binary. `bank migrate` and `bank serve` apply them, then River's own migrations under the same advisory lock; every other command checks both versions and stops when the schema or the job tables are behind or ahead of the binary.

## Milestones

1. ~~Foundation~~ — schema, migrations, blob store, WhatsApp importer, BM25 search, show/stats.
2. ~~Gmail~~ — loopback OAuth (PKCE), full backfill, incremental `history.list`, raw RFC 822 archived per message.
3. ~~Proton / Takeout~~ — shared EML/MIME parser, `bank import eml` (proton-mail-export output) and `bank import mbox`.
4. ~~Discord + LinkedIn~~ — GDPR/data-export package importers (csv and json package generations).
5. ~~Generic JSON~~ — `bank import json` (array or NDJSON, stdin-friendly): the escape hatch for agents and one-off sources.
6. ~~Client/server~~ — `bank serve` (stdlib HTTP, token auth), remote CLI via `BANK_URL`, `bank fetch` for attachment bytes.
7. Deploy — see DEPLOY.md (LUKS volume, containerized server and CLI, headless Gmail auth, restic, cron). Pending: actually provisioning the VPS.
8. ~~Integrity and retrieval~~: `bank import inbox` sweep, `bank thread`, `bank verify`, recipient search, match snippets, source freshness in stats.
9. ~~Identity~~ — `bank contact`: a canonical person with manually attached aliases, `--person` search, and an advisory `contact suggest`. Deliberately no automatic merging: mis-attributing someone's messages is worse than typing an alias, and every attachment is reversible because messages are never rewritten.
10. ~~Attachment text~~ — `bank extract`, `bank attachment`: PDFs, Office and OpenDocument files, HTML and text become searchable inside. See below.
11. Open, needing a design decision first: `bank mcp`, if an MCP wrapper ever beats the CLI. pgvector hybrid semantic search was considered and dropped (#30): remote embedding contradicts the threat model, local embedding needs cgo or a sidecar, and the lifecycle would be permanent upkeep in a system whose point is having no second search engine to sync.

## Attachment text

Extraction is a job of its own, not a step inside an importer. The text is derived data — rebuildable from the blobs forever — and keying it on the content means content, not attachment rows, is the unit of work. A content a disk scan already read is not read again.

| Content                              | Extractor                                     | Where it runs                        |
| ------------------------------------ | --------------------------------------------- | ------------------------------------ |
| PDF with a text layer                | pure Go (`ledongthuc/pdf`)                    | anywhere, including the server image |
| docx/xlsx/pptx, odt/ods/odp          | stdlib zip + XML                              | same                                 |
| HTML, plain text, csv, json, ical, … | stdlib, sharing the mail parser's `StripHTML` | same                                 |
| images, PDFs with no text layer      | tesseract + poppler, as subprocesses          | only the `ocr` image, or a laptop    |

Two decisions are worth the words:

**OCR is never on the import path and never in the server image.** tesseract means a C++ image stack and a libc in whatever links it, and the process serving the archive over a network port holds one static binary and no shell. It is also minutes per document against milliseconds for everything else, so a forty-page scan would block an upload for the length of the scan. A scanned page is therefore recorded as `needs_ocr` — an honest status, not a failure — and read afterwards.

`status = needs_ocr` is not a report, it is a queue. Storing it queues an OCR job on the `ocr` queue, and only `bank worker --queue ocr` works that queue, which is what makes OCR automatic without touching the import path; one setting (`COMPOSE_PROFILES=server,ocr`) turns it on. The worker reads its work from the database rather than being handed it, and that direction is the point: the server needs no docker socket — which would be root on the host and would undo the container hardening entirely — no sidecar API, and no knowledge that a worker exists. `bank extract --ocr` does the same as a one-off, or from a laptop against `BANK_URL` with better tools than tesseract.

**`needs_ocr` is a number, and the number is the argument.** Invoices, statements, tickets and contracts generated by software all carry text layers; if the archive is mostly those, OCR buys close to nothing. `bank attachment stats` counts exactly what it would add before anyone spends a week on it.

Text can also be written from outside: `bank attachment text <blake3> --set` (and `PUT /v1/attachments/{blake3}/text`) store a transcription from any model, marked `manual`, which no job overwrites. The list, the bytes and the write are all in the HTTP API, so the machine that runs the model does not have to be the machine that holds the archive.

## Jobs

Derived work runs in [River](https://riverqueue.com), a job queue whose tables live in the archive's database. That is the reason for it: a job is a row, so the transaction that writes an attachment or a library file also writes the text job its content needs, and the job exists exactly when the row does. Jobs are unique per kind and arguments while unfinished, so forty messages carrying one PDF queue one job.

| Kind          | Arguments    | Queue   | Attempts | Runs in                    |
| ------------- | ------------ | ------- | -------- | -------------------------- |
| `text`        | `content_id` | default | 3        | `bank serve`, 4 at a time  |
| `ocr`         | `content_id` | `ocr`   | 3        | `bank worker --queue ocr`  |
| `gmail_sync`  | none         | default | 1        | `bank serve`, every hour   |
| `inbox_sweep` | none         | default | 1        | `bank serve`, every 15 min |

A text or OCR job that fails or panics is retried with River's backoff, and its last failure stores `failed` as the content's text status. A scheduled job is not retried, because the next tick is the retry, and a tick that finds the previous run unfinished is skipped. `bank serve` is the only client that can lead, so it alone schedules jobs, moves retries along and cleans up finished jobs; `bank worker` only works its queue. On SIGTERM both stop fetching, give running jobs the same 30 seconds as requests, and cancel what is left.

## Files on disks

The catalogue of files on disks shares the database and the content identity with the archive: `volumes`, `scans`, `entries` and their versions, archive listings, metadata and enrichment results are keyed on the same `contents` rows as attachments and library files, and `texts` is one table for both. A document read by a disk scan or by a text job is read once, and a ref such as `content:3f9a1c2b4d5e6f70` names the same bytes wherever they are.

The disks attach to a Windows PC and Postgres listens only on the server's loopback, so `bank disk` reaches the catalogue only through the API, like every other command. Only reading files happens on the PC: a scan sends its work in numbered batches that the server applies with the same reconciliation code, `verify` rereads files against a paged listing of their digests, `dedupe apply` records each move it made, and `get` copies from places the server lists. The server never knows which disks are attached; each command matches the volumes' fingerprints against the PC's mounts.

Enrichment calls an AI provider that can take minutes per file, so a run leases each content's work under its policy instead of holding a lock across the call. The worker renews the lease while the provider runs. A lease that runs out, because the worker crashed or lost its connection, makes the work claimable again, and a result whose lease went to another worker is refused, so a late answer cannot replace a current one. [DISKS.md](DISKS.md#design) has the catalogue's identities, versions, extraction and dedupe decisions.
