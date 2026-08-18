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
| Remote access | `bank serve` in the same binary, CLI switches to HTTP when `BANK_URL` is set, bearer tokens hashed in `$BANK_DATA_DIR/tokens`, no TLS | A laptop CLI against a remote `DATABASE_URL` writes blobs and archives locally while rows go to the VPS — split-brain. One binary means no second artifact to build or deploy; Tailscale is the transport security, so the server only needs authentication |
| Scope | Full history, all attachments | Attachments are content-addressed (sha256) so duplicates are free |

## Source acquisition

| Source | Method | Automation |
|---|---|---|
| Gmail | Gmail API, incremental via `historyId`; initial backfill via full list | cron |
| ProtonMail | official `proton-mail-export` CLI (paid plan) dumping EML into the inbox dir | cron |
| Discord | GDPR data package ("Request my data"), dropped into inbox | manual, ~quarterly |
| LinkedIn | official data export CSV, dropped into inbox | manual, ~quarterly |
| WhatsApp | per-chat "Export chat" zips from the phone, dropped into inbox | manual |
| ChatGPT | official data export zip (conversations.json, message tree incl. regenerated branches) | manual, on demand |
| Claude.ai | official data export zip (conversations.json) | manual, on demand |
| Claude Code | local session .jsonl transcripts (user/assistant text only, tool noise dropped) | `bank import claude-code ~/.claude/projects` |
| anything else | `bank import json` — JSON array or NDJSON on stdin/file | agents, scripts |

Deliberately inside ToS everywhere. If WhatsApp manual export gets old, the escape hatches are (a) one-shot Android backup decrypt (`wa-crypt-tools`) for deep backfill, (b) a whatsmeow linked-device bridge for live capture — both documented here so the schema already fits them.

## Data model

Everything normalizes to one `messages` table; source-specific richness stays in the raw archive.

- `messages(id, source, external_id, thread_id, sender, recipients[], subject, body, sent_at, raw_ref, ingested_at)`
  - `unique (source, external_id)` makes every importer idempotent — re-importing a dump is always safe.
  - Sources without stable IDs (WhatsApp) derive `external_id = sha256(thread|sent_at|sender|body)`.
- `attachments(id, message_id, filename, mime_type, size_bytes, sha256)` — bytes live in the blob store, not the DB.
- BM25 index over `subject, body, sender, recipients` via `pg_search`; fuzzy matching with `paradedb.match(..., distance => n)`; match snippets from `paradedb.snippet`, with a locally cut window as the fallback (the engine produces no highlight for fuzzy matches).

## Filesystem layout (`$BANK_DATA_DIR`, default `~/.local/share/aqt-bank`)

```
blobs/ab/abcdef…        content-addressed attachments (sha256, two-char fan-out)
archive/<source>/…      raw inputs exactly as received (mbox, zips, CSV, EML) — re-ingestable forever
inbox/<source>/         drop zone for manual exports; `bank import inbox` sweeps and moves to archive/
```

## CLI

```
bank import whatsapp <file.zip|.txt>…   # per-source explicit import
bank import inbox                       # sweep the inbox drop zone
bank sync                               # pull deltas from API sources (Gmail)
bank search "query" [--source s] [--from alice] [--to bob] [--since 2024-01-01] [--until d]
                    [--fuzzy 0..2] [--limit 1..500] [--json]
bank thread <id> [--source s] [--limit n] [--json]   # one whole conversation, oldest first
bank show <id> [--json]                 # full message + attachment refs
bank stats [--json]                     # counts, date ranges, last import, last sync
bank fetch <sha256> [-o path]           # write an attachment to a file
bank verify [--heal] [--source s]       # archive integrity; --heal rebuilds from archived raw inputs
bank serve [--listen addr]              # HTTP API for remote CLIs (default 127.0.0.1:8480)
bank token new|list|revoke <name>       # bearer tokens for bank serve
```

With `BANK_URL` (and `BANK_TOKEN`) set, `search`, `thread`, `show`, `stats`, `import` and `fetch` talk to a remote `bank serve` instead of Postgres — same flags, same output. `auth`, `sync`, `serve`, `token`, `verify` and `import inbox` are always local: they need the archive, the blob store or the token file on the same box.

Migrations are embedded in the binary and run automatically on startup — idempotent, no separate step.

## Milestones

1. ~~Foundation~~ — schema, migrations, blob store, WhatsApp importer, BM25 search, show/stats.
2. ~~Gmail~~ — loopback OAuth (PKCE), full backfill, incremental `history.list`, raw RFC 822 archived per message.
3. ~~Proton / Takeout~~ — shared EML/MIME parser, `bank import eml` (proton-mail-export output) and `bank import mbox`.
4. ~~Discord + LinkedIn~~ — GDPR/data-export package importers (csv and json package generations).
5. ~~Generic JSON~~ — `bank import json` (array or NDJSON, stdin-friendly): the escape hatch for agents and one-off sources.
6. ~~Client/server~~ — `bank serve` (stdlib HTTP, token auth), remote CLI via `BANK_URL`, `bank fetch` for attachment bytes.
7. Deploy — see DEPLOY.md (LUKS volume, compose override, headless Gmail auth, restic, cron). Pending: actually provisioning the VPS.
8. ~~Integrity and retrieval~~ — `bank import inbox` sweep, `bank thread`, `bank verify --heal`, recipient search, match snippets, source freshness in stats.
9. Open, both needing a design decision first: identity resolution across sources (one person, many handles) and pgvector hybrid semantic search (`bank mcp` if an MCP wrapper ever beats the CLI).
