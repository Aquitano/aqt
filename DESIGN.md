# aqt-bank — personal message archive

One place for every message I've ever sent or received, searchable in milliseconds from a CLI, by me and by my agents.

## Decisions (locked 2026-08-17)

| Area | Choice | Why |
|---|---|---|
| Runtime | Go, single `bank` binary | Static binary on the VPS, easy cron, no runtime to babysit |
| Store | Postgres + ParadeDB `pg_search` | One system of record; BM25 ranking + fuzzy/typo tolerance in-database, no sync pipeline to a second search engine |
| Hosting | VPS, LUKS-encrypted data volume, restic encrypted backups | Accepts that a running box is readable by the provider; protects disks at rest and backups |
| Sync model | Pull-based: `bank sync` via cron; manual sources land in an inbox dir swept by `bank import` | Stateless, debuggable, no daemon |
| Interface | CLI, `--json` on every read command | Humans get text, agents get JSON; MCP wrapper can come later |
| Scope | Full history, all attachments | Attachments are content-addressed (sha256) so duplicates are free |

## Source acquisition

| Source | Method | Automation |
|---|---|---|
| Gmail | Gmail API, incremental via `historyId`; initial backfill via full list | cron |
| ProtonMail | official `proton-mail-export` CLI (paid plan) dumping EML into the inbox dir | cron |
| Discord | GDPR data package ("Request my data"), dropped into inbox | manual, ~quarterly |
| LinkedIn | official data export CSV, dropped into inbox | manual, ~quarterly |
| WhatsApp | per-chat "Export chat" zips from the phone, dropped into inbox | manual |

Deliberately inside ToS everywhere. If WhatsApp manual export gets old, the escape hatches are (a) one-shot Android backup decrypt (`wa-crypt-tools`) for deep backfill, (b) a whatsmeow linked-device bridge for live capture — both documented here so the schema already fits them.

## Data model

Everything normalizes to one `messages` table; source-specific richness stays in the raw archive.

- `messages(id, source, external_id, thread_id, sender, recipients[], subject, body, sent_at, raw_ref, ingested_at)`
  - `unique (source, external_id)` makes every importer idempotent — re-importing a dump is always safe.
  - Sources without stable IDs (WhatsApp) derive `external_id = sha256(thread|sent_at|sender|body)`.
- `attachments(id, message_id, filename, mime_type, size_bytes, sha256)` — bytes live in the blob store, not the DB.
- BM25 index over `subject, body, sender` via `pg_search`; fuzzy matching with `paradedb.match(..., distance => n)`.

## Filesystem layout (`$BANK_DATA_DIR`, default `~/.local/share/aqt-bank`)

```
blobs/ab/abcdef…        content-addressed attachments (sha256, two-char fan-out)
archive/<source>/…      raw inputs exactly as received (mbox, zips, CSV, EML) — re-ingestable forever
inbox/<source>/         drop zone for manual exports; `bank import inbox` sweeps and moves to archive/
```

## CLI

```
bank import whatsapp <file.zip|.txt>…   # per-source explicit import
bank import inbox                       # sweep the inbox drop zone (later milestone)
bank sync                               # pull deltas from API sources (Gmail, Proton) (later milestone)
bank search "query" [--source s] [--from alice] [--since 2024-01-01] [--until d]
                    [--fuzzy 0..2] [--limit n] [--json]
bank show <id> [--json]                 # full message + attachment refs
bank stats [--json]
```

Migrations are embedded in the binary and run automatically on startup — idempotent, no separate step.

## Milestones

1. **Foundation (this repo state)** — schema, migrations, blob store, WhatsApp importer, BM25 search, show/stats. Verifiable offline end-to-end.
2. Gmail: OAuth device flow, full backfill from `messages.list`, incremental `history.list`, MIME → body extraction, attachments.
3. Proton: `proton-mail-export` wrapper + shared EML/mbox parser (reused for Gmail Takeout too).
4. Discord GDPR package importer (messages/*.csv + index.json), LinkedIn export importer (messages.csv).
5. Deploy: VPS provisioning notes (LUKS volume, docker compose, restic), cron for `bank sync`.
6. Nice-to-haves as needed: `bank mcp`, embeddings column for semantic search (pgvector lives happily next to pg_search).
