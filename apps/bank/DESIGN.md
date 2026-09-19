# aqt-bank — personal message archive

One place for every message I've ever sent or received, searchable in milliseconds from a CLI, by me and by my agents.

## Decisions (locked 2026-08-17)

| Area          | Choice                                                                                                                                | Why                                                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Go, single `bank` binary                                                                                                              | Static binary on the VPS, easy cron, no runtime to babysit                                                                                                                                                                                                                          |
| Store         | Postgres + ParadeDB `pg_search`                                                                                                       | One system of record; BM25 ranking + fuzzy/typo tolerance in-database, no sync pipeline to a second search engine                                                                                                                                                                   |
| Hosting       | VPS, LUKS-encrypted data volume, restic encrypted backups, everything in containers                                                   | Accepts that a running box is readable by the provider; protects disks at rest and backups. The server runs non-root on a read-only rootfs from a distroless image with no shell, so a bug in the process that serves the archive over a network port reaches as little as possible |
| Sync model    | Pull-based: `bank sync` via cron; manual sources land in an inbox dir swept by `bank import`                                          | Stateless, debuggable, no daemon. One exception, added deliberately: the optional OCR worker, because minutes-per-document work cannot sit on the import path and a timer is the only thing that makes it automatic                                                                 |
| Interface     | CLI, `--json` on every read command                                                                                                   | Humans get text, agents get JSON; MCP wrapper can come later                                                                                                                                                                                                                        |
| Remote access | `bank serve` in the same binary, CLI switches to HTTP when `BANK_URL` is set, bearer tokens hashed in `$BANK_DATA_DIR/tokens`, no TLS | A laptop CLI against a remote `DATABASE_URL` writes blobs and archives locally while rows go to the VPS — split-brain. One binary means no second artifact to build or deploy; Tailscale is the transport security, so the server only needs authentication                         |
| Scope         | Full history, all attachments                                                                                                         | Attachments are content-addressed (sha256) so duplicates are free                                                                                                                                                                                                                   |

## Source acquisition

| Source        | Method                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Automation                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Gmail         | Gmail API, incremental via `historyId`; initial backfill via full list                                                                                                                                                                                                                                                                                                                                                                                        | cron                                                      |
| ProtonMail    | official `proton-mail-export` CLI (paid plan) dumping EML into the inbox dir                                                                                                                                                                                                                                                                                                                                                                                  | cron                                                      |
| Discord       | GDPR data package ("Request my data"), dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                     | manual, ~quarterly                                        |
| LinkedIn      | official data export CSV, dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                                  | manual, ~quarterly                                        |
| WhatsApp      | per-chat "Export chat" zips from the phone, dropped into inbox                                                                                                                                                                                                                                                                                                                                                                                                | manual                                                    |
| YouTube       | Google Takeout, "YouTube and YouTube Music" → history (`watch-history.html` by default, `watch-history.json` when the export is set to "Multiple formats" — prefer JSON: HTML timestamps are localized, and a layout the parser does not know skips the record); not in the Data API, so Takeout is the only route. Watch history only — search history is a log of two-word queries that would dilute BM25 for common words while adding nothing retrievable | scheduled Takeout export into Drive, swept into the inbox |
| ChatGPT       | official data export zip (conversations.json or numbered shards, message tree incl. regenerated branches)                                                                                                                                                                                                                                                                                                                                                     | manual, on demand                                         |
| Claude.ai     | official data export zip (conversations.json)                                                                                                                                                                                                                                                                                                                                                                                                                 | manual, on demand                                         |
| Claude Code   | local session .jsonl transcripts (user/assistant text only, tool noise dropped)                                                                                                                                                                                                                                                                                                                                                                               | `bank import ai` (or claude-code + a path)                |
| Codex CLI     | local rollout .jsonl files (subagent/guardian threads and injected context dropped)                                                                                                                                                                                                                                                                                                                                                                           | `bank import ai` (or codex + a path)                      |
| OpenCode      | local opencode.db, snapshotted while live, OAuth-token tables stripped from the snapshot                                                                                                                                                                                                                                                                                                                                                                      | `bank import ai` (or opencode + a path)                   |
| Antigravity   | per-conversation transcript.jsonl under the brain dir (tool steps dropped)                                                                                                                                                                                                                                                                                                                                                                                    | `bank import ai` (or antigravity + a path)                |
| anything else | `bank import json` — JSON array or NDJSON on stdin/file                                                                                                                                                                                                                                                                                                                                                                                                       | agents, scripts                                           |

The harness sources differ from exports in two ways. Their raw input is one file that grows in place, so the archive keeps a single superseding copy per session file (`archive.Replace`) instead of accumulating a new hash-named copy per sync — for OpenCode that raw is deliberately the sanitized snapshot, and its archive name carries a per-host discriminator so several machines can sync into one server. And `bank import ai` syncs rather than imports: a session file whose exact bytes are already archived was fully ingested by an earlier run (archiving happens after ingest) and is skipped unparsed; `bank import <kind> <path>` and `bank reimport` always do the full pass. Claude Code archives made before the superseding scheme keep their hash-prefixed names; they stay valid for reimport and simply stop multiplying.

Deliberately inside ToS everywhere. If WhatsApp manual export gets old, the escape hatches are (a) one-shot Android backup decrypt (`wa-crypt-tools`) for deep backfill, (b) a whatsmeow linked-device bridge for live capture — both documented here so the schema already fits them.

## Data model

Everything normalizes to one `messages` table; source-specific richness stays in the raw archive.

- `messages(id, source, external_id, thread_id, sender, recipients[], subject, body, sent_at, raw_ref, ingested_at)`
  - `unique (source, external_id)` makes every importer idempotent — re-importing a dump is always safe.
  - Sources without stable IDs derive one: WhatsApp from `sha256(thread|sent_at|sender|body)`, YouTube from `sha256(video|second watched)`, falling back to the title for a record whose export names no video — overlapping Takeout exports of the same watch collapse, a second watch of the same video does not. Which URL forms yield a video id therefore decides identity, not just parsing.
  - Citations use a derived `ref`, not `id`: `substr(sha256(source || '\x00' || coalesce(nullif(message_id,''), external_id)), 1, 12)`, computed in the select list of every read and accepted by `bank show`. `id` is a row serial, so rebuilding the archive repoints every `bank:<id>` a note ever recorded; the ref depends only on the pair that already defines a message's identity, and survives. Deliberately not stored and not indexed — a stored copy could disagree with the formula, and a sequential scan answers a ref lookup in a fraction of a second at this scale.
  - `thread_id` is the source's own conversation id wherever there is one — ChatGPT `conversation_id`, Claude.ai `uuid`, a Claude Code session id, a Discord channel id — and the human title lives in `subject`. Titles repeat ("New chat", a #general on every server) and get renamed, so keying threads on them merged unrelated conversations and split renamed ones.
- `attachments(id, message_id, filename, mime_type, size_bytes, sha256)` — bytes live in the blob store, not the DB.
- `blob_text(sha256, text, extractor, status)` + a denormalized `messages.attachment_text` — text read out of attachments, keyed on content so a document attached to forty messages is extracted once. The column is what the BM25 index sees; `store.RefreshAttachmentText` recomputes it wholesale in one idempotent statement, so there is no trigger and no bookkeeping to drift. One index means one score and working snippets; two indexes would mean inventing a fusion rule.
- `contacts(id, name, note)` + `contact_aliases(contact_id, source, value, value_norm)` — one person, many source-specific identities. Aliases are attached by hand and match everywhere unless scoped to a source; nothing merges automatically, so a wrong attachment is undone by detaching it and the identity each source recorded is never rewritten.
- `message_id_collapsed(…, collapsed_into, collapsed_at)` — rows the Message-ID uniqueness migration deleted, kept so an unattended collapse stays reviewable and the raw files it orphaned stay reachable.
- BM25 index over `subject, body, sender, recipients, attachment_text` via `pg_search`; results are ordered by score, then `sent_at`, then `id` — the id is what makes it a total order, so a page means the same thing twice. Paging is `--offset`, capped at 10000: every offset re-ranks the whole match set, and past that narrowing the query beats paging through it. Search defaults to any-word matching; `--match all` requires each whitespace-separated term across the searchable fields, and `--match phrase` requires adjacent tokens in order within one field. Exact matches receive additional weight and subject matches receive three times the field weight. Fuzzy matching uses `paradedb.match(..., distance => n)`; match snippets from `paradedb.snippet`, with a locally cut window as the fallback (the engine produces no highlight for fuzzy matches).

Thread pages use `(sent_at, id)` cursors, scoped by source and thread ID. `--around` centers a page on a search hit; `--before`, `--after`, and `--latest` reach the rest of the history. The browser uses `GET /v1/threads` for typed conversation summaries instead of assembling SQL.

## Filesystem layout (`$BANK_DATA_DIR`, default `~/.local/share/aqt-bank`)

```
blobs/ab/abcdef…        content-addressed attachments (sha256, two-char fan-out)
archive/<source>/…      raw inputs exactly as received (mbox, zips, CSV, EML) — re-ingestable forever.
                        The one exception: a YouTube Takeout archives only its history file — the
                        rest of the export is other sources' data, archived under their own names
inbox/<source>/         drop zone for manual exports; `bank import inbox` sweeps and moves to archive/
```

## CLI

```
bank import whatsapp <file.zip|.txt>…   # per-source explicit import
bank import youtube <takeout.zip|dir>   # YouTube watch history (Takeout)
bank import inbox                       # sweep the inbox drop zone
bank sync                               # pull deltas from API sources (Gmail)
bank search "query" [--source s] [--from alice] [--to bob] [--person alice]
                    [--since 2024-01-01] [--until d] [--fuzzy 0..2] [--limit 1..500]
                    [--offset 0..10000] [--json]
bank contact add|rm|list|show <name>    # one person across their many identities
bank contact alias add|rm <name> <email|handle|source:name>...
bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--offset n] [--json]
bank contact suggest [--limit n]        # identities in the archive no contact claims yet
bank contact import <file|-> [--json]   # a whole contact book at once (JSON array or NDJSON)
bank thread <id> [--source s] [--limit n] [--json]   # one whole conversation, oldest first
bank show <id|ref> [--json]             # full message + attachment refs
bank stats [--json]                     # counts, date ranges, last import, last sync, coverage
bank coverage <source> <text>           # note what a source holds (empty text clears)
bank fetch <sha256> [-o path]           # write an attachment to a file
bank verify [--heal] [--source s]       # archive integrity; --heal rebuilds from archived raw inputs
bank serve [--listen addr]              # HTTP API for remote CLIs (default 127.0.0.1:8480)
bank token new|list|revoke <name>       # bearer tokens for bank serve
```

With `BANK_URL` (and `BANK_TOKEN`) set, `search`, `thread`, `show`, `stats`, `contact`, `import` and `fetch` talk to a remote `bank serve` instead of Postgres — same flags, same output. `auth`, `sync`, `serve`, `token`, `verify`, `reimport` and `import inbox` are always local: they need the archive, the blob store or the token file on the same box. All of them except `auth` and `serve` refuse outright when `BANK_URL` is set — acting on the wrong box is the split-brain the Decisions table's "Remote access" row exists to prevent, and the CLI should not need the operator to remember which side a command belongs on.

Migrations are embedded in the binary and run automatically on startup — idempotent, no separate step.

## Milestones

1. ~~Foundation~~ — schema, migrations, blob store, WhatsApp importer, BM25 search, show/stats.
2. ~~Gmail~~ — loopback OAuth (PKCE), full backfill, incremental `history.list`, raw RFC 822 archived per message.
3. ~~Proton / Takeout~~ — shared EML/MIME parser, `bank import eml` (proton-mail-export output) and `bank import mbox`.
4. ~~Discord + LinkedIn~~ — GDPR/data-export package importers (csv and json package generations).
5. ~~Generic JSON~~ — `bank import json` (array or NDJSON, stdin-friendly): the escape hatch for agents and one-off sources.
6. ~~Client/server~~ — `bank serve` (stdlib HTTP, token auth), remote CLI via `BANK_URL`, `bank fetch` for attachment bytes.
7. Deploy — see DEPLOY.md (LUKS volume, containerized server and CLI, headless Gmail auth, restic, cron). Pending: actually provisioning the VPS.
8. ~~Integrity and retrieval~~ — `bank import inbox` sweep, `bank thread`, `bank verify --heal`, recipient search, match snippets, source freshness in stats.
9. ~~Identity~~ — `bank contact`: a canonical person with manually attached aliases, `--person` search, and an advisory `contact suggest`. Deliberately no automatic merging: mis-attributing someone's messages is worse than typing an alias, and every attachment is reversible because messages are never rewritten.
10. ~~Attachment text~~ — `bank extract`, `bank attachment`: PDFs, Office and OpenDocument files, HTML and text become searchable inside. See below.
11. Open, needing a design decision first: `bank mcp`, if an MCP wrapper ever beats the CLI. pgvector hybrid semantic search was considered and dropped (#30): remote embedding contradicts the threat model, local embedding needs cgo or a sidecar, and the lifecycle would be permanent upkeep in a system whose point is having no second search engine to sync.

## Attachment text

Extraction is a pass of its own, not a step inside an importer. The text is derived data — rebuildable from the blobs forever — and keying it on the sha256 means content, not attachment rows, is the unit of work.

| Content                              | Extractor                                     | Where it runs                        |
| ------------------------------------ | --------------------------------------------- | ------------------------------------ |
| PDF with a text layer                | pure Go (`ledongthuc/pdf`)                    | anywhere, including the server image |
| docx/xlsx/pptx, odt/ods/odp          | stdlib zip + XML                              | same                                 |
| HTML, plain text, csv, json, ical, … | stdlib, sharing the mail parser's `StripHTML` | same                                 |
| images, PDFs with no text layer      | tesseract + poppler, as subprocesses          | only the `ocr` image, or a laptop    |

Two decisions are worth the words:

**OCR is never on the import path and never in the server image.** tesseract means a C++ image stack and a libc in whatever links it, and the process serving the archive over a network port holds one static binary and no shell. It is also minutes per document against milliseconds for everything else, so a forty-page scan would block an upload for the length of the scan. A scanned page is therefore recorded as `needs_ocr` — an honest status, not a failure — and read afterwards.

`status = needs_ocr` is not a report, it is a queue. The optional `bank extract --ocr --watch` worker drains it on a timer, which is what makes OCR automatic without touching the import path; one setting (`COMPOSE_PROFILES=server,ocr`) turns it on. The worker reads its work from the database rather than being handed it, and that direction is the point: the server needs no docker socket — which would be root on the host and would undo the container hardening entirely — no sidecar API, and no knowledge that a worker exists. Extraction is idempotent per blob, so a worker overlapping with an import's own pass costs a repeated read at worst. The same command runs as a one-off, or from a laptop against `BANK_URL` with better tools than tesseract.

**`needs_ocr` is a number, and the number is the argument.** Invoices, statements, tickets and contracts generated by software all carry text layers; if the archive is mostly those, OCR buys close to nothing. `bank attachment stats` counts exactly what it would add before anyone spends a week on it.

Text can also be written from outside: `bank attachment text <sha256> --set` (and `PUT /v1/attachments/{sha256}/text`) store a transcription from any model, marked `manual`, which no automatic pass overwrites. The list, the bytes and the write are all in the HTTP API, so the machine that runs the model does not have to be the machine that holds the archive.
