# aqt-bank

Personal archive and library: messages, media, viewing activity, playlists, files, and selected Markdown pages in one searchable Postgres database. See [LIBRARY.md](LIBRARY.md) for the library model, imports, and Brain search. See [DESIGN.md](DESIGN.md) for architecture.

Bank imports personal ChatGPT and Claude.ai exports. Turnstash owns coding-session
ingestion. Removing an importer does not delete previously archived records.

Bank also catalogues the files on disks that come and go: see [Files on disks](#files-on-disks) and [DISKS.md](DISKS.md).

Every route is a typed Go handler in `internal/server/*_api.go`, on the operation and error types in `internal/httpapi`: parameters and bodies are declared on structs, so their parsing and bounds checks are generated, and uploads and downloads stream. `GET /openapi.json` is the one document that describes them all, and a failure is always JSON with a `_tag`, a `message` and, where the caller can act, a `recovery`. A rejected parameter or body answers 422, including a body that is too large or too slow, which Huma would otherwise answer with 400, 408 or 413. A failure is the server's, a 500 whose cause stays in the log, unless a typed or sentinel error says it is invalid input, missing or a conflict. `openapi.json` is the committed copy: regenerate it with `go run ./cmd/bank openapi > openapi.json`, because a test fails while it is stale.

See [MAIL.md](MAIL.md) for folder-preserving imports, mail filters, conversation grouping, and metadata recovery. See [IMAP.md](IMAP.md) for the Proton Bridge and Gmail collector.

## Quickstart

```sh
docker compose up -d          # ParadeDB (Postgres + pg_search)
go build -o bank ./cmd/bank
./bank migrate                # create or upgrade the schema

./bank auth gmail             # once; then:
./bank sync                   # incremental Gmail pull (bank serve runs it hourly)

./bank imap --config imap.json --check   # check IMAP login and folders
./bank imap --config imap.json          # collect Proton Bridge/Gmail IMAP continuously

./bank import whatsapp "WhatsApp Chat with Alice.zip"
./bank import eml ~/proton-export/            # proton-mail-export output
./bank import mbox takeout/All\ mail.mbox     # Gmail Takeout
./bank import discord package.zip             # GDPR data package
./bank import linkedin Complete_LinkedInDataExport.zip
./bank import chatgpt chatgpt-export.zip        # ChatGPT data export (zip or unpacked
                                                #  dir; uploaded/generated files come
                                                #  along as attachments, and a later full
                                                #  export adds files a bare JSON lacked)
./bank import claude claude-export.zip          # Claude.ai data export
./bank import netflix NetflixViewingHistory.csv --account thomas
./bank import youtube-media takeout.zip --account thomas   # YouTube history, playlists and music
./bank library upload soundtrack.flac notes.pdf
./bank library index ~/brain/wiki --source brain --account wiki
echo '{"body":"note to self","thread":"ideas"}' | ./bank import json --source notes -

./bank import inbox                             # sweep $BANK_DATA_DIR/inbox/<kind>/
                                                #  (bank serve sweeps every 15 minutes)

./bank serve                                    # the API, text jobs, sync and sweep
./bank worker --queue ocr                       # OCR jobs for scanned documents (needs tesseract)
./bank extract --status failed                  # re-read text by hand
./bank attachment stats                         # how much is searchable inside

./bank contact add alice                        # one person, many identities
./bank contact alias add alice alice@example.com "whatsapp:Alice" discord:alice_x
./bank contact messages alice                   # everything she sent or received
./bank contact import contacts.json             # a whole contact book at once
./bank contact self thomas                      # the owner, whom browse leaves out of members

./bank search "that invoice" --from alice --since 2024-01-01
./bank search "alice retainer"                  # every word, each in any field
./bank search '"quarterly review" deck'         # quoted words are adjacent and in order
./bank search "retainer invoice" --any          # any of the words, fuller matches first
./bank search "retainer"                        # also text inside PDFs and Office files
./bank search "the deck" --to bob               # by recipient
./bank search "that invoice" --person alice     # every identity she uses
./bank search "quarterlly reprot" --json        # long words tolerate typos; agents consume this
./bank search "invoice" --limit 50 --offset 50  # the next page
./bank show msg:9454d9440ade1088                # the ref a citation carries
./bank show msg:9454d9440ade1088 --provenance   # raw input and mail grouping evidence
./bank show content:3f9a1c2b4d5e6f70            # any ref: bytes, where they are on disks and in the archive
./bank show content:3f9a1c2b4d5e6f70 --text     # the text read from them
./bank thread "Alice" --source whatsapp --around msg:9454d9440ade1088 --limit 100
                                                # context centered on a search hit
./bank thread "Alice" --source whatsapp --before msg:9454d9440ade1088 --limit 100
                                                # earlier messages, without a history cap
./bank stats                                    # counts, freshness, notes, files on disks
./bank note whatsapp "only the chats exported in 2025-08"
./bank query --schema                           # tables and columns, before the first query
./bank query "select source, count(*) from messages group by 1"
                                                # read-only ad-hoc SQL: READ ONLY tx,
                                                # 15s timeout, row cap — analytics only
./bank verify                                   # hash every stored blob the database names
./bank reimport chatgpt                         # replay stored ChatGPT inputs through today's importer
./bank reimport                                 # replay every stored raw input
./bank retire --source notes --external-prefix draft:   # dry run; --apply deletes, leaving tombstones
```

## Remote use

When Postgres lives on a VPS, run the server there in a container (`COMPOSE_PROFILES=server docker compose up -d`, published on a Tailscale address — there is no TLS) and set two env vars on the laptop. Every command that reads or changes the archive calls the API: over HTTP to that server when `BANK_URL` is set, and otherwise through the same handler served in process from `DATABASE_URL` and `BANK_DATA_DIR`, with no socket, no token and no jobs. Validation, defaults, errors and output are therefore the same either way, and an import lands its rows, blobs and raw input on one box. `worker`, `migrate`, `token`, `sync`, `verify`, `retire`, `reimport` and `import inbox` work on the server's own database, blob store or token file, and refuse to run with `BANK_URL` set.

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
# through the server's own image, so the digest lands in the file it reads
export BANK_TOKEN=$(ssh vps 'cd /opt/aqt/apps/bank && docker compose run --rm -T bank token new laptop')

./bank import whatsapp "WhatsApp Chat with Alice.zip"   # uploaded to the VPS
./bank fetch 3f9a1c2b... -o photo.jpg                   # attachment bytes back, by BLAKE3 digest
```

`bank ui` opens a local archive browser (search, thread-grouped browse, contacts, stats) at `127.0.0.1:8481`. It needs `BANK_URL`/`BANK_TOKEN` and attaches the token server-side, so it never reaches the browser. The page is a Vite + React app on the shared `@aqt/ui` components in `internal/webui/app`; its built `dist/` is committed and embedded, so `go build` needs no JS toolchain — after changing the app, rebuild with `bun run build` there.

Stats shows each source's last import, recorded sync checkpoint, and note.
Sources flagged as stale by the API show **No recent imports**. A recent sync does
not imply that new messages were imported.

Run `bun run check:dist` in `internal/webui/app` to rebuild and check the embedded
assets against Git. Commit the rebuilt `dist/` with its source changes. CI and
`mise run bank:ts` run the same check.

Agents on a client machine get the CLI handed to them by a Claude Code skill: [skill/README.md](skill/README.md), or the read operations as tools through `bank mcp`: see [Agents over MCP](#agents-over-mcp).

Deployment (VPS, LUKS, containerized server, OCR worker, restic, cron): [DEPLOY.md](DEPLOY.md).

Attachments can contain any file type. Gmail sync and EML/MBOX imports preserve MIME attachments, including inline images. A link to a cloud-hosted file is still a link; Bank does not download its target.

Gmail retries reconcile attachments even when the message row already exists. To repair earlier partial imports, run `bank sync --full` on the server. This re-fetches existing mail and can take as long as the original backfill; normal syncs use history deltas.

ChatGPT imports preserve referenced assets included in the full export ZIP or directory. Importing only `conversations.json` imports text without the asset files. Missing files appear in the import's missing-media count. Reimporting a fuller export fills missing attachments even when a message already has some files, without duplicating those files.

Not every stored attachment is searchable inside. Audio, video, archives, and other binary files can be stored and downloaded without searchable contents. Supported document attachments are searchable inside. A text job reads PDFs, Office and OpenDocument files, HTML and plain text, keyed on the content so a document attached to forty messages, or already read by a disk scan, is read once.

Background work runs as jobs in a [River](https://riverqueue.com) queue in the same database. Storing an attachment or a library file whose bytes have no text yet queues a text job in the same transaction, so the job exists exactly when the row does, and the content is queued once however many messages carry it. `bank serve` works the default queue, four jobs at a time, and schedules the Gmail sync every hour and the inbox sweep every 15 minutes. A tick that finds the previous run still going is skipped, and a failed run is retried by the next tick. A text job stores the text against the content, where search finds it for every message, library file and disk that holds those bytes. A text or OCR job that fails or panics is tried three times and then recorded as `failed`; `bank extract --status failed` reads those again by hand. Imports on a machine without a running `bank serve` queue their text jobs until one starts. `/healthz` reports how many jobs wait, run and have failed in each queue.

Scanned pages and images hold no text layer, so they are recorded as `needs_ocr` rather than guessed at, which queues an OCR job on the `ocr` queue. Only `bank worker --queue ocr` works that queue, wherever tesseract is installed: on the deployed box that is the `bank-ocr` service, turned on by adding `ocr` to `COMPOSE_PROFILES`. `bank attachment text <blake3> --set` takes a transcription from anywhere else, including a model running on the client, and marks it `manual` so no job overwrites it. `--clear` drops the text and queues the content to be read again.

Config via env (see `.env.example`): `DATABASE_URL`, `BANK_DATA_DIR` (blobs, which include raw inputs, and the inbox; default `~/.local/share/aqt-bank`).

For automatic IMAP collection from Proton Bridge, Gmail or another provider,
see [IMAP.md](IMAP.md) and [imap.example.json](imap.example.json). The collector
runs beside Bridge or on another client machine and uploads to `BANK_URL`.
It keeps local checkpoints, retries failures and preserves mailbox read flags.

Schema migrations are embedded and run through Tern in `bank migrate` and when
`bank serve` starts, followed by River's own migrations for its job tables.
Every other command stops with an error when either the
schema or the job tables are at another version than the binary's. See
[DEPLOY.md](DEPLOY.md) before upgrading.

Ad-hoc SQL requires `BANK_QUERY_DATABASE_URL`, a separate restricted login created
with [deploy/query-role.sql](deploy/query-role.sql). It never falls back to the
import connection. The login has SELECT on public tables and sequences, schema USAGE, and no write,
server-file, program-execution, or administrative grants. READ ONLY transactions,
a 15-second timeout, and the role's `work_mem` and `temp_file_limit` provide
additional limits. The query runs as a cursor, which accepts one SELECT, VALUES or
TABLE statement, and reading stops at the row cap or at 8 MiB of values; a value
over 64 KiB is cut. `truncated` and `cut_values` in `--json` say when either
happened. Other read commands work without this setting.

## Search

`bank search` and `GET /v1/search` search every kind of record at once and return one ranked list of hits.

- **Grammar.** A query is words and `"quoted phrases"`, parsed once in `internal/search` for every kind. By default every word and phrase must match, each in any of a record's fields; `--any` (`match=any`) needs one of them. A word of up to four characters must match exactly, one of five to eight characters tolerates one typo, a longer one two. A quoted word or phrase is exact. A piece with no letter or digit is ignored.
- **Tokenizers.** Prose (subjects, bodies, document text, titles, notes, descriptions) uses pg_search's Unicode word tokenizer with ASCII folding, so `fur` finds `für`. Names, filenames, paths, senders and recipients use its source code tokenizer with folding, which also splits `MinecraftServer` and `pingpong_final`; filenames and disk names add a trigram field, so `werkstudent` finds `Werkstudentenvertrag.pdf`.
- **One engine.** Every kind is ranked by BM25 in a pg_search index: messages, document text, attachment and library filenames, media items with their notes and tags, activity, collections, published pages, and the catalogue's names, archive members, metadata and image analyses. Filters people use (source, account, kind, dates, thread, participants, volume, extension) are fields of those indexes, so a filtered page is selected inside the index.
- **One list.** Each kind's index returns its best `offset + limit` hits, equal scores in a fixed order (messages newest first), and the lists run concurrently. Reciprocal rank fusion merges them: a hit's score is the sum of `1 / (60 + rank)` over the lists that found it, so a record found by two lists, such as a PDF whose name and text both match, ranks above one found by either. `limit` and `offset` page the fused list. An unfiltered search runs twelve lists, each one round trip with a page and a count, then three statements for the places of the files on the page; a filter that a kind cannot apply skips its list.
- **Hits.** A hit has its kind, ref, title, a plain-text snippet, a date for messages and activity, and what opens it: a message's source and thread, a file's places. Search never returns a body. A file is one hit whatever holds it: its places list the messages it is attached to, the library files and the copies on disks. `counts` says how many records of each kind match, `coverage` what a filter left out. Every word of an all-words query must be in one list's fields: a file matches by its name or by its text, not by a word from each.
- **Filters.** `--from`, `--to`, `--person`, `--thread`, `--subject`, `--mailbox-id` and `--has-attachment` keep messages and the files attached to them. `--account` keeps library records. A date keeps messages, activity and files attached to messages sent then. `--source` leaves files on disks out. `--person` matches a message whose sender or recipients carry any of the contact's aliases, through the indexed `messages.participants`.

`bank search` without words browses conversations by their latest matching message, newest first, and continues with `--after <ref>` from the last row's ref. Browse leaves the owner, the contact `bank contact self` marks, out of a thread's members.

## Files on disks

The catalogue of files on disks lives in the same database: volumes, entries, scans and what was read from each file. A file on a disk, a message attachment and a library file with the same bytes share one `contents` row and the text read from it. `bank search` ranks files on disks in the same list as messages and the library, `bank show content:<hex>` lists where a content lives, and `bank stats` counts them.

`bank disk` holds the commands that run on the machine the disks attach to: `scan`, `search`, `entry`, `get`, `verify`, `enrich`, `analysis`, `volumes`, `scans`, `skips`, `dupes`, `redundancy`, `dedupe plan|apply`, `organize prepare|apply|undo` and `config`. They reach the catalogue only through the API, like every other command, so the Windows PC the disks attach to needs `BANK_URL` and a token and never a database connection. [DISKS.md](DISKS.md) has setup, use, configuration and the catalogue's design.

```powershell
bank disk scan E:\
bank disk search werkstudent --ext pdf
bank disk get 36331 --to C:\Recovered\document.pdf
bank disk redundancy --volume Data
```

## Retrieve conversation history

`bank thread` returns a chronological page with `has_before` and `has_after` in JSON. Use `--around <ref>` to include a search hit, `--latest` to start at the newest messages, or `--before` and `--after` with the refs of a page's first and last messages. These positions are mutually exclusive. Each page contains 20 messages unless `--limit` asks for up to 500, and includes attachment metadata.

The browser opens search results around the matching message and provides **Load earlier** and **Load later** controls. Browse opens the newest page and loads older conversations after the last one shown. Contact history also has **Load earlier**; CLI callers can use `bank contact messages <name> --before <ref>` to continue beyond the offset limit.

## Forget messages

`bank retire --source <source> --external-prefix <prefix>` deletes the messages of one source whose external IDs start with a prefix, such as rows that another import now holds in a better form. It prints counts and samples per prefix and changes nothing until `--apply`. `--replacement-map` takes a CSV of `ref,replacement` rows, or a JSON object of ref to ID, naming the item, activity or collection that replaces a cited message; `--apply` refuses to run while the map names a ref no retiring row has. `--reason` is stored with each row.

Each deleted row leaves a tombstone in `message_tombstones` with its source, external ID, Message-ID, ref, date, subject, raw input, reason and replacement. Every message import skips a tombstoned source and external ID, and for mail a tombstoned Message-ID, so a re-upload, `bank reimport` or an inbox sweep cannot bring the row back; the import counts it as retired. `bank show <ref>` for a retired ref prints the tombstone and its replacement, and `GET /v1/messages/{ref}` answers `410 Gone` with the tombstone under `retired`.

Run it on the server, because `retire` refuses to run through `BANK_URL`, and back up first with the `pg_dump` block in [DEPLOY.md](DEPLOY.md) §7: the delete has no undo except that dump. Blobs and raw inputs stay.

## Agents over MCP

`bank mcp` serves the Model Context Protocol on stdin and stdout. Its tools are the API operations marked as tools in `openapi.json` (`x-agent-tool`): search, resolving a ref, a message, a thread page, conversations without words, the timeline, stats, contacts, the library records, and the text, tags and places on disks of a file. Each tool's name is the operation's ID, and its description and argument schema are the operation's, with their defaults and bounds. Every tool only reads. A call goes through the same client as the CLI, so `bank mcp` works against `BANK_URL` with a read-only token, or in process from `DATABASE_URL` without one. A failure comes back as a tool error holding the API's tagged JSON, with `recovery` where there is one.

Register it with an MCP client, such as Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "bank": {
      "command": "bank",
      "args": ["mcp"],
      "env": {
        "BANK_URL": "http://vps.tailnet.ts.net:8480",
        "BANK_TOKEN": "bank_..."
      }
    }
  }
}
```

Mint the token with `bank token new <agent> --read-only` on the server.

## Refs

Every record that can be cited has one written form, `kind:value` in lowercase hex:

| Ref                       | Names                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `msg:<16 hex>`            | A message. Its ref is stored with it and survives rebuilding the archive from the same sources.        |
| `content:<16 to 64 hex>`  | Bytes, by a prefix of their BLAKE3 digest. All 64 characters name exactly one content.                 |
| `item:<32 hex>` and so on | A library record: `item:`, `activity:`, `collection:`, `file:` or `page:`. The ref is the record's ID. |

`bank show`, `bank thread`, the `bank disk` commands and every route that takes a ref accept only this form. A bare value, an uppercase one or a message row number is rejected. Messages have no public row number; JSON names them by `ref` alone.

LinkedIn conversations use the export's conversation ID.

## Check database behavior

`go test -race ./...` uses pgtestdb to clone a private database per test on the disposable ParadeDB server in `BANK_TEST_DATABASE_URL`. The tests never read `DATABASE_URL`, so exporting it for the CLI cannot point them at the archive. The configured login must be a superuser so it can create databases, install the search extension and provision a restricted query-test login. Local tests skip database cases when `BANK_TEST_DATABASE_URL` is unset or no server is listening, unless `CI` is set. CI always requires the database and starts the same pinned ParadeDB image as Compose. `mise run bank:check` also runs the shared `packages/go/pgschema` tests, which read `PGSCHEMA_TEST_DATABASE_URL`; it can name the same disposable server.

The retrieval cases in `internal/store/search_quality_integration_test.go` check folding, filename fragments, typo tolerance, exact short words, phrase order, all-word matches across fields and ranking across kinds through the combined search. Run them with `go test ./internal/store -run TestSearchRetrievalCases`.

## Raw inputs and replay

Bank stores every input in the blob store and records it as a raw input before it parses it. That covers a file or directory given to `bank import`, an upload, an inbox file, each message Gmail sync or the IMAP collector fetches, and each `bank library index` publication. A directory is packed into one zip named `<dir>.zip`, so its media comes along. The same bytes under the same name and options are one raw input. Importing them again reruns that input and replaces its report.

A kind's options are the flags of `bank import <kind>`, such as `--source`, `--account`, `--date-order` or `--mailbox`. They are stored with the raw input, so a replay reads the input the same way. An unknown option is an error. Over HTTP, `POST /v1/import/<kind>` takes a multipart upload with an optional `options` field holding the options as JSON, followed by the `file` field.

When parsing fails, the raw input records status `failed` and the error, and its bytes stay stored. `bank reimport [kind...]` replays every stored raw input of those kinds, or of every kind, in id order through today's importers. It runs on the server. Imports skip messages that already exist, so a replay adds messages and attachments an earlier run missed and leaves stored messages as they were.

## Undated messages

A message whose source gives no date has no `sent_at`. It sorts before every dated message: first in a thread read oldest first, and last in newest-first lists such as browse, contact history and search ties. `--since`, `--until` and `bank timeline` leave undated messages out. `bank stats` counts them as `undated`, and JSON omits `sent_at` for them.

## Import generic JSON

`bank import json` reads a JSON array, a single object or NDJSON, from a file or from stdin with `-`. Each entry needs `body` or `subject` and can carry `source`, `external_id`, `thread`, `sender`, `recipients`, `sent_at` and `attachments`. An entry with an unknown field is rejected. An attachment is `{"filename": "report.pdf", "mime_type": "application/pdf", "data": "<base64>"}`, where `filename` is required and `data` holds the bytes as standard base64. The bytes travel inside the input, so the same file imports locally, over `BANK_URL` and on replay. `sent_at` takes RFC 3339, `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` or unix seconds. A time without a zone is read as UTC, and a missing or null `sent_at` leaves the message undated. Without `external_id`, the ID is a hash of the source, thread, sender, subject, body and `sent_at` as written in the file.

## Import reports, files, and branches

The browser's **Imports** tab and `bank reports` list raw inputs newest first, each
with the report of its latest import, including failures and unfinished runs. A
report counts messages inserted, duplicates, retired messages, attachments and
library records, and counts issues by kind: `missing_media`, `rejected`,
`skipped`, `unsupported`, `damaged`, `incomplete` and `dropped`. It keeps the
first 100 issue details. The status is `gaps` when any issue other than
`dropped` occurred.

```sh
bank reports --json
bank reports --before 42 --limit 50
bank attachment find --filename invoice --type pdf --person alice --since 2025-01-01
bank attachment find --text "payment due" --type pdf
bank attachment messages <blake3> --offset 0 --limit 50
```

Submitted search filters and selections live in the browser URL. Refreshing,
switching tabs, and using Back or Forward restore the search. Bookmark the URL
to keep a search. Each message has a **Message link** based on its stable ref,
so the link still resolves after rebuilding the archive from the same sources.

The **Contacts** tab can create a contact or attach a suggested identity to an
existing one. Open a contact and expand **Manage identities** to add or remove
emails and usernames. Each identity can match one source or all sources.

Open **Files**, then **Message attachments** to search filenames and filter by extension, MIME type or
category such as `image`, contact name, and message date. The before-date filter
is exclusive. Identical bytes share one library entry, even under different
filenames. Selecting a file shows PDF/image previews, extracted document text
when available, and every message containing those bytes. Message results include
occurrences outside the selected filters. Original files remain downloadable. The **Library files** subtab lists uploaded standalone files.

**Contents contain** searches extracted text within each file, ignoring case.
It matches the supplied phrase literally. Files without extracted text cannot
match this filter. Results show a matching excerpt, and **Jump to match** locates
the query in the text preview. Click an attachment in a conversation to read
the same preview without leaving the message. The API accepts this filter as
`text` on `/v1/attachment-library`; the CLI uses `attachment find --text`.

ChatGPT imports retain reply parents and branch identifiers. Alternative answers
are labeled separately, and **Read branch to here** shows only the selected
message's reply path. **View parent message** also works when the parent lies
outside the loaded page. Claude imports retain explicit parent IDs when the
export supplies them. `bank show`, `bank thread`, and their JSON output include
the relationships.

Reimporting keeps message IDs and existing bodies. A bare ChatGPT JSON export retains asset-only
messages and reports their missing files; importing the full export later can
restore those attachments.
