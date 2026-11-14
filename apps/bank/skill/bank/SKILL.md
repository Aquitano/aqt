---
name: bank
description: Search or write the owner's personal archive through the `bank` CLI or its MCP tools. Use when a task needs something he wrote or received in email, WhatsApp, Discord, LinkedIn, or personal ChatGPT and Claude.ai conversations, something in his media library, or a file he kept, attached or has on a disk. Also use to retrieve attachments or save a note, decision, or messages to the archive.
---

# bank: the owner's archive

One Postgres holding every message from every source, a media library, stored files and a catalogue of the files on disks, searched together from the CLI or over MCP. Read freely, write rarely.

## Preflight

Run once before the first archive command in a session:

```sh
command -v bank
test -n "$BANK_URL" && echo BANK_URL=set
test -n "$BANK_TOKEN" && echo BANK_TOKEN=set
bank stats
```

`bank stats` is the cheapest end-to-end check — if it prints a source table, everything works. Distinct failure modes, all of which mean stop and report rather than retry:

- `command -v bank` prints nothing — the binary is not installed on this machine. Report that; do not try to build or download it.
- `bank: migrate: failed to connect to ...: connection refused` — no `BANK_URL`, so the CLI tried to serve the API in process from a local Postgres that is not there. On a client machine that means `BANK_URL`/`BANK_TOKEN` are not exported into this shell; ask the owner to set them (see `skill/README.md` in the aqt-bank repo).
- `bank: send Authorization: Bearer <token>; the owner mints one with ...` — HTTP 401. `BANK_TOKEN` is unset, wrong or revoked. The owner has to run `bank token new <machine-name>` on the server and re-export the printed value; it is shown once.
- `dial tcp ...: connect: connection refused`, or a hang ending in an i/o timeout — the server is down or Tailscale is disconnected. Report; retrying will not help.

Calling the HTTP API directly instead of the CLI: `GET /openapi.json` describes the routes, a failure is JSON with `_tag` and `message`, and a route that takes a JSON body needs `Content-Type: application/json` or no Content-Type at all; anything else is refused.

On the VPS itself there is no `BANK_URL`; `DATABASE_URL` points at Postgres and the same commands work locally.

## MCP instead of the CLI

When the session has bank's MCP tools (`bank mcp` serves them: `search`, `resolveRef`, `getMessage`, `getThread`, `getDiskContentText` and more), read through them instead of the CLI. Each tool is one API operation that reads. Its arguments are the CLI flags below without dashes (`q` for the words, `kind`, `source`, `person`, `since`, `limit`, `offset`), its result is the JSON `--json` prints, and the semantics below hold for both. A failure is a tool error whose text is the API's JSON with `_tag`, `message` and, when you can act on it, `recovery`. The usual path is `search`, then `getMessage` or `resolveRef` on a hit's ref, then `getThread` with the hit's `thread_id`, `source` and its ref as `around`, or `getDiskContentText` for a file's text, which comes 20000 characters at a time. No tool writes: imports, notes and contacts stay with the CLI.

## Reading

```sh
bank search 'words "a phrase"' [--kind message|item|activity|collection|file|page] [--source s] [--thread id] [--from name] [--to name] [--person contact] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--any] [--limit n] [--offset n] [--json]
bank thread <thread_id> [--source s] [--around ref|--before ref|--after ref|--latest] [--limit n] [--json]
bank contact list|show <name> [--json]               # who the owner has named, and their identities
bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--before ref|--offset n] [--json]
bank show <ref> [--json]         # any ref: a message's body, recipients and attachments, a library record,
                                 #  or a content's places; and where the same bytes are elsewhere
bank show content:<hex> --text   # the text read from a file, whether attached or on a disk
bank show content:<hex> --metadata  # its embedded image, document, audio and video tags
bank show msg:<hex> --provenance # the raw input, folder and mail grouping evidence
bank timeline <2019|2019-03|2019-03-14> [--group message|activity|file] [--limit n] [--json]
                                 # what happened in a year, month or day, oldest first
bank disk search <words> [--volume label] [--ext pdf] [--json]  # files on disks, with disk-only filters
bank stats [--json]              # sources, counts, date ranges, freshness, notes; files on disks
bank fetch <blake3> -o <path>    # write attachment bytes to a file
bank attachment stats [--json]   # how much of the archive is searchable inside its attachments
bank query <sql|-> [--limit n] [--json]   # read-only ad-hoc SQL — the analytics escape hatch
bank query --schema              # list tables and columns before writing the first query
```

Semantics that matter:

- Always pass `--json` when consuming output. A query search returns `{hits, counts, coverage}`: `hits` is one ranked list across every kind, `counts` says how many records of each kind match in all, and `coverage` says what the search left out or cannot prove. Search without a query returns a thread array. Thread and contact-history commands also return their existing response shapes.
- **Cite records by `ref`.** Every citable record has one written form, `kind:value`: `msg:<16 hex>` for a message, `content:<16 to 64 hex>` for bytes, and `item:`, `activity:`, `collection:`, `file:` or `page:` with 32 hex for a library record, whose ID is its ref. Each hit carries its `ref`, for example `msg:9454d9440ade1088`, and no row number. A folder or unhashed file on a disk has no ref; its place names the entry for `bank disk entry`. Copy refs exactly as printed: a bare value without its kind, or uppercase hex, is rejected. `bank show <ref>` shows any of them. Its `--json` names the record (`kind`, `title`), lists where the same bytes are under `links`, and holds the record itself under `record`.
- One query grammar serves every kind: bare words, and `"quoted phrases"` whose words must be adjacent and in order. By default every word and phrase must match, each in any of a record's fields; `--any` needs one of them and ranks fuller matches first. A word of five to eight characters tolerates one typo and a longer one two; shorter words and quoted words match exactly. Accents do not matter: `uberweisung` finds `Überweisung`. A part of a filename finds the file: `werkstudent` finds `Werkstudentenvertrag.pdf`.
- Every kind is ranked by BM25 in its own index, and the lists are merged by reciprocal rank fusion, so `score` orders the list but means nothing on its own. `matched` names the lists a hit came from. Each hit has `kind` (message, file, item, activity, collection or page), `ref`, `title`, a plain-text `snippet` around the match, `at` for messages and activity, and for a message its `source` and `thread_id`. Search never returns a body: `bank show <ref>` does.
- A `file` hit is bytes, wherever they are. Its `places` list the messages that carry them as an attachment, the library files and the copies on disks, and `place_count` counts them all. When a file matched by its text, quote the snippet as coming from the document, not from what a sender wrote.
- Searching finds text inside PDFs, Office and OpenDocument files, HTML and text attachments. It does **not** find text in scanned pages or photographs unless someone has OCR'd them: `bank show <ref>` reports `text_status` per attachment, where `needs_ocr` means the words are pixels and invisible to search. If a document ought to contain something and does not match, check that before concluding the archive lacks it.
- `--from` needs its words in the sender field, ignoring case and accents, so `--from alice` matches `Alice Example` and `alice@example.com`. `--to` is the same against recipients. When browsing without words they are substrings instead.
- `--person <contact>` is the better filter when you know who you mean: a contact ties one person's email addresses, WhatsApp display name and Discord handle together, so it catches them across sources where `--from alice` only catches one spelling. Run `bank contact list` to see which exist; an unknown name is an error, not an empty result.
- `--until` is exclusive; both take `YYYY-MM-DD`, which starts at UTC midnight, or an RFC 3339 instant. A date leaves out the kinds without one: items, collections, pages, library files and files on disks.
- A message whose source gave no date is undated: its JSON has no `sent_at`, and `--since`/`--until` leave it out. It sorts before every dated message, so it comes first in a thread and last in newest-first lists. `bank stats` counts undated messages separately.
- `--limit` defaults to 20 and must be between 1 and 500. Out-of-range values are a usage error, not an empty result. Raise it (50-100) when skimming for something specific, then narrow with `--source`/`--person`/dates rather than re-running blind.
- `--offset` pages the one ranked list: `--limit 100 --offset 100` is the second hundred hits. A short page is the end of the list. `counts` shows what lies behind a `--kind` filter. `--offset` is capped at 10000. Narrow the query if you need more.
- Browsing without words (`bank search --source whatsapp`) lists conversations by their latest message; continue with `--after <last_ref of the last row>`.
- `bank thread` takes a message hit's `thread_id` and `source`. Pass `--around <hit.ref> --limit 100` to include that hit in context. Pages include attachments and `has_before`/`has_after`; continue with `--before <first.ref>` or `--after <last.ref>`. Use `--latest` for recent history. Positions are mutually exclusive, a page holds 20 messages by default and at most 500, and there is no total history cap.
- Contact history can continue with `bank contact messages <name> --before <last.ref>`, beyond the offset limit. Results are newest-first. Use the cursor without `--offset`.
- `bank contact show <name>` lists a person's attached identities and how many messages each source contributes — the quickest way to tell whether `--person` will actually reach the conversation you want, or whether an identity is still unattached.
- `bank stats --json` is `{sources, disks}`. Each of `sources[]` has `last_ingest`, and `last_sync` for sync-backed ones. Use it to say "the archive has nothing after X" instead of assuming a gap means nothing happened.
- **Read a source's `note` before concluding anything from absence.** It is the owner's note on what a source actually holds ("only the chats exported in 2025-08"), and it is the difference between "it never happened" and "that period was never imported". `stale: true` means nothing new has landed in that source for 30 days — a gap there may be a broken import rather than a quiet month. Both come back in `bank stats --json`.

Worked examples:

```sh
# "what did Alice say about the invoice back then"
bank search "invoice" --from alice --since 2024-01-01 --json

# "did I ever discuss pgvector with ChatGPT"
bank search "pgvector" --source chatgpt --limit 50 --json

# a typo in a long word is tolerated; quote words that must be exact and adjacent
bank search "hetzner invoise" --limit 5
bank search '"quarterly review" deck' --json

# one hit is rarely the answer — pull the surrounding conversation
bank search "release plan" --kind message --json     # hits[].thread_id, .source, .ref
bank thread "release plan chat" --source whatsapp --around msg:9454d9440ade1088 --limit 100 --json

# "what did I send to bob about the deck"
bank search "deck" --to bob --json

# "what has Alice ever said about the lease" — across mail, WhatsApp and Discord
bank contact list                                  # -> the names that exist
bank search "lease" --person alice --limit 50 --json
bank contact messages alice --since 2024-01-01 --json

# grab the screenshot attached to a message
bank show msg:9454d9440ade1088 --json   # -> record.attachments[].blake3
bank fetch 3f9a1c2b4d5e6f70a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718 -o /tmp/screenshot.jpg

# what is even in here, and how far back
bank stats --json
```

## Ad-hoc SQL (`bank query`)

For questions search cannot answer — counts, trends, group-bys, joins — `bank query`
runs one SQL query against the archive and returns `{columns, rows, truncated, cut_values}`.
The server authenticates SQL with a separate restricted PostgreSQL login. It
requires `BANK_QUERY_DATABASE_URL`; missing configuration disables ad-hoc queries.
The login has SELECT on public tables and sequences, with schema USAGE. It
must have no role memberships, write, administrative,
server-file, or program-execution privileges. A READ ONLY transaction, 15s timeout,
100-row default cap and single-statement protocol add limits. `--limit` can raise
the cap to 10000. This depends on the documented database role configuration;
a READ ONLY transaction alone does not prevent a privileged login from running
server-side programs or reading server files. The statement runs as a cursor, so it
must be one SELECT, VALUES or TABLE, and reading stops at the row cap or at 8 MiB of
values; a value over 64 KiB comes back cut and is counted in `cut_values`. Queries
work locally and over `BANK_URL`.

- **The row cap is silent in the text form.** 100 rows is the default and the text table gives no visible sign it was hit (the warning goes to stderr). Always `--json` and check `truncated`, or pass an explicit `--limit`; treating a capped page as the whole answer is how a count comes out wrong.
- Start with `bank query --schema` to see the tables and columns; do not guess names.
- Aggregate on the server; do not `select body from messages` to summarize client-side —
  that is what `bank search` and `bank show` are for, and bodies are private
  correspondence (the same quote-the-minimum rule applies to query results).
- `truncated: true` means the row cap or the size cap cut the result — aggregate harder or raise
  `--limit`, don't silently treat the page as complete.
- A SQL error comes back verbatim (422, `_tag: InvalidRequest`); fix the query rather than retrying it unchanged.
- Pass the statement as one shell-quoted argument, or `-` to read it from stdin
  (the sane way for anything multi-line).

```sh
# messages per source per year
bank query "select source, extract(year from sent_at)::int as y, count(*)
            from messages group by 1, 2 order by 1, 2" --json

# who sent the most mail since 2025
bank query "select sender, count(*) n from messages
            where source = 'gmail' and sent_at >= '2025-01-01'
            group by 1 order by n desc limit 20"

# recurring-payment candidates: same sender, similar subject, several months
bank query "select sender, count(*) n, min(sent_at)::date first, max(sent_at)::date last
            from messages where subject ilike '%receipt%' or subject ilike '%rechnung%'
            group by 1 having count(*) >= 3 order by n desc"
```

## Sources

`whatsapp`, `gmail`, `proton`, `discord`, `linkedin`, `chatgpt`, `claude` (Claude.ai exports), plus any name created by a past `bank import json --source <name>`. Previously imported sources remain readable. Run `bank stats` to see which exist before filtering on one. A `--source` typo silently returns nothing.

## Writing

This is the owner's archive; writes are for things worth keeping, not for scratch state.

Contacts are the owner's own map of who is who, and attaching the wrong identity silently attributes a stranger's messages to someone. Do not run `bank contact add`, `bank contact alias add/rm`, `bank contact import` or `bank contact rm` on your own initiative — read them freely, and if an identity looks unattached, say so and let the owner decide. `bank contact suggest` is safe: it only lists identities no contact claims yet (LLM roles from the AI chat sources are filtered out of it).

For a batch — an address-book export, or the identities a `contact suggest` pass turned up — you may **draft** an import file and hand it over; the owner runs the import. Same rule as above: drafting is a proposal, applying it is theirs.

```sh
bank contact import <file|-> [--json]
```

A JSON array or NDJSON of `{"name": "Björn", "note": "the one with the servers", "aliases": ["bjoern@example.com", "whatsapp:Björn", "discord:bjoern_aq"]}`. Aliases take the same `<source>:<value>` scoping as `contact alias add`, a bare value matching everywhere. Existing contacts are extended rather than replaced, and an alias another contact already claims is reported and skipped without stopping the rest of the file.

`bank note <source> <text>` maintains the per-source notes (an empty text clears one). Same rule again: propose the wording, let the owner run it.

```sh
echo '{"body":"note text","thread":"decisions","sender":"claude","sent_at":"2026-08-17T12:00:00Z"}' \
  | bank import json --source agent-notes -
```

Input is a JSON array, a single object, or NDJSON, on stdin (`-`) or a file path. Fields: `body` required (`subject` alone also passes); `thread`, `sender`, `recipients`, `subject`, `sent_at`, `external_id`, `attachments` optional. An unknown field rejects the entry. Each attachment is `{"filename": "...", "mime_type": "...", "data": "<base64>"}`: `filename` is required and `data` holds the bytes as standard base64. `sent_at` takes RFC 3339, `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` or unix seconds. A time without a zone is read as UTC. Without `sent_at` the message is stored undated.

Dedup is stable: with no `external_id`, the id is a hash of source, thread, `sent_at` as written, sender, subject and body. Re-importing an identical entry is a no-op and prints `0 new, 1 already known`. An entry without `sent_at` hashes without a date, so re-running a file is safe.

Rules:

- Do not invent a source name. Check `bank stats` and reuse the existing agent-notes-style source if one is there; only create a new one when the owner asks.
- Set an explicit `sent_at`. An entry without one is stored undated, not at the import time.
- Every import is a write to the shared archive — say what you are about to store before storing it.
- Attachments travel inside the JSON as base64 `data`, so they import the same way locally and over `BANK_URL`. The old `attachments[].path` field is unknown now and rejects its entry.

## Cautions

- `bank fetch` writes a file to disk; pick an explicit `-o` under a temp dir, and remember the bytes are personal data.
- Message bodies are private correspondence. Read what the task needs, quote the minimum, and do not paste whole threads into summaries or commit messages.
- `sync`, `worker`, `migrate`, `token`, `verify`, `retire`, `reimport`, `import inbox` and `mail rebuild` are server-side commands: they need the archive, the blob store or the token file on the server itself. Run from a client machine they refuse with `BANK_URL` set, so they fail loudly rather than acting on the wrong box. `auth` and `serve` are server-side too but do not refuse — `bank auth gmail` on a client and copying the resulting `gmail/` directory to the server is a supported route.
- `bank reimport [kind...]` replays the stored raw inputs through today's importers on the server. It adds messages and attachments an earlier run missed and leaves stored messages as they are. Suggest it to the owner rather than running it.
