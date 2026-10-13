---
name: bank
description: Search or write the owner's personal message archive through the `bank` CLI. Use when a task needs something he wrote or received in email, WhatsApp, Discord, LinkedIn, or personal ChatGPT and Claude.ai conversations. Also use to retrieve attachments from those messages or save a note, decision, or messages to the archive.
---

# bank — the owner's message archive

One Postgres holding every message from every source, BM25-searchable from the CLI. Read freely, write rarely.

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
- `bank: migrate: failed to connect to ...: connection refused` — no `BANK_URL`, so the CLI fell back to a local Postgres that is not there. On a client machine that means `BANK_URL`/`BANK_TOKEN` are not exported into this shell; ask the owner to set them (see `skill/README.md` in the aqt-bank repo).
- `bank: GET /v1/stats: invalid or missing bearer token` — HTTP 401. `BANK_TOKEN` is unset, wrong or revoked. The owner has to run `bank token new <machine-name>` on the server and re-export the printed value; it is shown once.
- `dial tcp ...: connect: connection refused`, or a hang ending in an i/o timeout — the server is down or Tailscale is disconnected. Report; retrying will not help.

On the VPS itself there is no `BANK_URL`; `DATABASE_URL` points at Postgres and the same commands work locally.

## Reading

```sh
bank search "query" [--kind message|item|activity|collection|file|page] [--source s] [--from name] [--to name] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--match any|all|phrase] [--fuzzy 0-2] [--limit n] [--offset n] [--json]
bank thread <id> [--source s] [--around id|--before id|--after id|--latest] [--limit n] [--json]
bank contact list|show <name> [--json]               # who the owner has named, and their identities
bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--before id|--offset n] [--json]
bank show <id|ref> [--json]      # full body, recipients, raw_ref, attachment list
bank stats [--json]              # sources, counts, date ranges, freshness, coverage notes
bank fetch <sha256> -o <path>    # write attachment bytes to a file
bank attachment stats [--json]   # how much of the archive is searchable inside its attachments
bank query <sql|-> [--limit n] [--json]   # read-only ad-hoc SQL — the analytics escape hatch
bank query --schema              # list tables and columns before writing the first query
```

Semantics that matter:

- Always pass `--json` when consuming output. A query search returns an object with `messages`, `items`, `activity`, `collections`, `files`, `pages`, and `attachments` arrays, plus library `coverage` notes. Empty groups are `[]`. `--kind message` restricts the search but keeps this object shape. Search without a query returns a thread array. Thread and contact-history commands also return their existing response shapes.
- **Cite messages by `ref`, never by `id`.** Each `.messages[]` entry carries `ref`, 12 hex characters derived from the message itself. `id` is a row number that can change after rebuilding the archive. Write `bank:<ref>`, for example `bank:c5e63bfc3750`. `bank show` accepts either form. Library records have typed IDs and source provenance, not message citation refs.
- Message ranking is BM25 over subject, body, sender, recipients, and extracted attachment text, with typo tolerance (`--fuzzy 1` by default, max 2). Library groups use Postgres full-text search without fuzzy matching. Scores from separate groups are not comparable. The default `--match any` matches words independently. Use `--match all` to require every term across searchable fields, or `--match phrase` for adjacent words in order. Message phrase matching ignores `--fuzzy`.
- Each message result carries a `snippet`: a bounded plain-text window around the match. Read message fields from `.messages[]`; item, activity, collection, file, page, and attachment results have different schemas.
- A result may also carry `attachment_snippet`, meaning the match is inside an attached document rather than the message body — quote it as coming from the attachment, not from what the sender wrote. It is only set for exact-token matches; a fuzzy hit inside a document leaves it empty.
- Searching finds text inside PDFs, Office and OpenDocument files, HTML and text attachments. It does **not** find text in scanned pages or photographs unless someone has OCR'd them: `bank show <id>` reports `text_status` per attachment, where `needs_ocr` means the words are pixels and invisible to search. If a document ought to contain something and does not match, check that before concluding the archive lacks it.
- `--from` is a case-insensitive substring of the sender field, so `--from alice` matches `Alice Example` and `alice@example.com`. `--to` is the same against recipients.
- `youtube` rows are watch events, not correspondence: the sender is the channel, the subject the video title, the body only the watch URL, and the thread is the channel — so `--source youtube --from fireship` is everything watched from one channel, and `bank thread <channel id> --source youtube` reads it in order. Advertisements are not imported, and a video the export no longer names keeps its title with no URL.
- `--person <contact>` is the better filter when you know who you mean: a contact ties one person's email addresses, WhatsApp display name and Discord handle together, so it catches them across sources where `--from alice` only catches one spelling. Run `bank contact list` to see which exist; an unknown name is an error, not an empty result.
- `--until` is exclusive; both dates are plain `YYYY-MM-DD`.
- `--limit` defaults to 20 and must be between 1 and 500; `--fuzzy` between 0 and 2. Out-of-range values are a usage error, not an empty result. Start generous (50-100), then narrow with `--source`/`--from`/dates rather than re-running blind.
- `--offset` reaches past the first page: `--limit 100 --offset 100` is the second hundred in each selected result group. Check each group's array length separately. A short `.messages` page does not establish that `.items` or `.files` is exhausted. Use `--kind` to page one category. Each category keeps its own ordering. `--offset` is capped at 10000. Narrow the query if you need more. Contact message history retains its separate array pagination.
- `.messages[]` contains message bodies already. Use `bank show <id>` when you need recipients, `external_id`, `raw_ref`, or attachments.
- `bank thread` takes a `.messages[]` hit's `thread_id` and `source`. Pass `--around <hit.id> --limit 100` to include that hit in context. Pages include attachments and `has_before`/`has_after`; continue with `--before <first.id>` or `--after <last.id>`. Use `--latest` for recent history. Positions are mutually exclusive, page size is capped at 2000, and there is no total history cap. Numeric IDs are paging cursors for the current archive; keep using `ref` for durable citations.
- Contact history can continue with `bank contact messages <name> --before <last.id>`, beyond the offset limit. Results are newest-first. Use a positive cursor without `--offset`.
- `bank contact show <name>` lists a person's attached identities and how many messages each source contributes — the quickest way to tell whether `--person` will actually reach the conversation you want, or whether an identity is still unattached.
- `bank stats --json` includes `last_ingest` per source, and `last_sync` for sync-backed ones. Use it to say "the archive has nothing after X" instead of assuming a gap means nothing happened.
- **Read `coverage` before concluding anything from absence.** It is the owner's note on what a source actually holds ("only the chats exported in 2025-08"), and it is the difference between "it never happened" and "that period was never imported". `stale: true` means nothing new has landed in that source for 30 days — a gap there may be a broken import rather than a quiet month. Both come back in `bank stats --json`.

Worked examples:

```sh
# "what did Alice say about the invoice back then"
bank search "invoice" --from alice --since 2024-01-01 --json

# "did I ever discuss pgvector with ChatGPT"
bank search "pgvector" --source chatgpt --limit 50 --json

# typo in the name, or in the archived text: widen the distance
bank search "hetzner invoise" --fuzzy 2 --limit 5

# one hit is rarely the answer — pull the surrounding conversation
bank search "release plan" --kind message --json     # messages[].thread_id, messages[].source
bank thread "release plan chat" --source whatsapp --around 42 --limit 100 --json

# "what did I send to bob about the deck"
bank search "deck" --to bob --json

# "what has Alice ever said about the lease" — across mail, WhatsApp and Discord
bank contact list                                  # -> the names that exist
bank search "lease" --person alice --limit 50 --json
bank contact messages alice --since 2024-01-01 --json

# grab the screenshot attached to a message
bank show 4 --json          # -> attachments[].sha256
bank fetch 407b467e378d279e4d2ed7d8418f12d6937e00f4d8b7d0310c12470883b0431d -o /tmp/screenshot.jpg

# what is even in here, and how far back
bank stats --json
```

## Ad-hoc SQL (`bank query`)

For questions search cannot answer — counts, trends, group-bys, joins — `bank query`
runs one SQL statement against the archive and returns `{columns, rows, truncated}`.
The server authenticates SQL with a separate restricted PostgreSQL login. It
requires `BANK_QUERY_DATABASE_URL`; missing configuration disables ad-hoc queries.
The login has SELECT on public tables and sequences, with schema USAGE. It
must have no role memberships, write, administrative,
server-file, or program-execution privileges. A READ ONLY transaction, 15s timeout,
100-row default cap and single-statement protocol add limits. `--limit` can raise
the cap to 10000. This depends on the documented database role configuration;
a READ ONLY transaction alone does not prevent a privileged login from running
server-side programs or reading server files. Queries work locally and over `BANK_URL`.

- **The row cap is silent in the text form.** 100 rows is the default and the text table gives no visible sign it was hit (the warning goes to stderr). Always `--json` and check `truncated`, or pass an explicit `--limit`; treating a capped page as the whole answer is how a count comes out wrong.
- Start with `bank query --schema` to see the tables and columns; do not guess names.
- Aggregate on the server; do not `select body from messages` to summarize client-side —
  that is what `bank search` and `bank show` are for, and bodies are private
  correspondence (the same quote-the-minimum rule applies to query results).
- `truncated: true` means the row cap cut the result — aggregate harder or raise
  `--limit`, don't silently treat the page as complete.
- A SQL error comes back verbatim (400); fix the query rather than retrying it unchanged.
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

`whatsapp`, `gmail`, `proton`, `discord`, `linkedin`, `youtube` (watch history from Google Takeout), `chatgpt`, `claude` (Claude.ai exports), plus any name created by a past `bank import json --source <name>`. Previously imported sources remain readable. Run `bank stats` to see which exist before filtering on one. A `--source` typo silently returns nothing.

## Writing

This is the owner's archive; writes are for things worth keeping, not for scratch state.

Contacts are the owner's own map of who is who, and attaching the wrong identity silently attributes a stranger's messages to someone. Do not run `bank contact add`, `bank contact alias add/rm`, `bank contact import` or `bank contact rm` on your own initiative — read them freely, and if an identity looks unattached, say so and let the owner decide. `bank contact suggest` is safe: it only lists identities no contact claims yet (LLM roles from the AI chat sources are filtered out of it).

For a batch — an address-book export, or the identities a `contact suggest` pass turned up — you may **draft** an import file and hand it over; the owner runs the import. Same rule as above: drafting is a proposal, applying it is theirs.

```sh
bank contact import <file|-> [--json]
```

A JSON array or NDJSON of `{"name": "Björn", "note": "the one with the servers", "aliases": ["bjoern@example.com", "whatsapp:Björn", "discord:bjoern_aq"]}`. Aliases take the same `<source>:<value>` scoping as `contact alias add`, a bare value matching everywhere. Existing contacts are extended rather than replaced, and an alias another contact already claims is reported and skipped without stopping the rest of the file.

`bank coverage <source> <text>` maintains the per-source coverage notes (an empty text clears one). Same rule again: propose the wording, let the owner run it.

```sh
echo '{"body":"note text","thread":"decisions","sender":"claude","sent_at":"2026-08-17T12:00:00Z"}' \
  | bank import json --source agent-notes -
```

Input is a JSON array, a single object, or NDJSON, on stdin (`-`) or a file path. Fields: `body` required (`subject` alone also passes); `thread`, `sender`, `recipients`, `subject`, `sent_at`, `external_id`, `attachments[].path` optional. `sent_at` takes RFC 3339, `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` or unix seconds, and defaults to import time.

Dedup is stable: with no `external_id`, the id is a hash of source, thread, `sent_at`, sender, subject and body, so re-importing an identical entry is a no-op — `json: 0 new, 1 already known`. Entries without `sent_at` hash to import-time-independent ids too, so re-running a file is safe.

Rules:

- Do not invent a source name. Check `bank stats` and reuse the existing agent-notes-style source if one is there; only create a new one when the owner asks.
- Set an explicit `sent_at` for anything that describes a moment other than now.
- Every import is a write to the shared archive — say what you are about to store before storing it.
- `attachments[].path` only works for local imports (the file is read into the blob store on this machine). Over `BANK_URL` any entry carrying attachments is rejected whole — `1 entries rejected`, nothing inserted — so strip attachments before remote imports, or run the import on the server.

## Cautions

- `bank fetch` writes a file to disk; pick an explicit `-o` under a temp dir, and remember the bytes are personal data.
- Message bodies are private correspondence. Read what the task needs, quote the minimum, and do not paste whole threads into summaries or commit messages.
- `sync`, `token`, `verify`, `reimport` and `import inbox` are server-side commands: they need the archive, the blob store or the token file on the server itself. Run from a client machine they refuse with `BANK_URL` set, so they fail loudly rather than acting on the wrong box. `auth` and `serve` are server-side too but do not refuse — `bank auth gmail` on a client and copying the resulting `gmail/` directory to the server is a supported route.
- `bank reimport mbox --heal-bodies` re-reads archived mail and replaces bodies the parser now reads better — the fix for old mail stored as an "open this in an HTML viewer" stub. It reports without writing unless `--apply` is passed, and only ever replaces a body with a strictly longer one. Suggest it when a mail's stored body is visibly a template rather than the message; run it on the server.
