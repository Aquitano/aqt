# aqt-bank

Personal archive and library: messages, media, viewing activity, playlists, files, and selected Markdown pages in one searchable Postgres database. See [LIBRARY.md](LIBRARY.md) for the library model, imports, and Brain search. See [DESIGN.md](DESIGN.md) for architecture.

Bank imports personal ChatGPT and Claude.ai exports. Turnstash owns coding-session
ingestion. Removing an importer does not delete previously archived records.

See [MAIL.md](MAIL.md) for folder-preserving imports, mail filters, conversation grouping, and metadata recovery. See [IMAP.md](IMAP.md) for the Proton Bridge and Gmail collector.

## Quickstart

```sh
docker compose up -d          # ParadeDB (Postgres + pg_search)
go build -o bank ./cmd/bank

./bank auth gmail             # once; then:
./bank sync                   # incremental Gmail pull (cron this)

./bank imap --config imap.json --check   # check IMAP login and folders
./bank imap --config imap.json          # collect Proton Bridge/Gmail IMAP continuously

./bank import whatsapp "WhatsApp Chat with Alice.zip"
./bank import eml ~/proton-export/            # proton-mail-export output
./bank import mbox takeout/All\ mail.mbox     # Gmail Takeout
./bank import discord package.zip             # GDPR data package
./bank import linkedin Complete_LinkedInDataExport.zip
./bank import youtube takeout.zip               # YouTube watch history from Google
                                                #  Takeout (zip, unpacked dir, or the
                                                #  watch-history.json/.html itself)
./bank import chatgpt chatgpt-export.zip        # ChatGPT data export (zip or unpacked
                                                #  dir; uploaded/generated files come
                                                #  along as attachments, and re-importing
                                                #  heals an earlier text-only pass)
./bank import claude claude-export.zip          # Claude.ai data export
./bank import netflix NetflixViewingHistory.csv --account thomas
./bank import youtube-media takeout.zip --account thomas
./bank library upload soundtrack.flac notes.pdf
./bank library index ~/brain/wiki --source brain --account wiki
echo '{"body":"note to self","thread":"ideas"}' | ./bank import json --source notes -

./bank import inbox                             # sweep $BANK_DATA_DIR/inbox/<kind>/

./bank extract                                  # read text out of attachments
./bank extract --ocr                            # scanned documents (needs tesseract)
./bank attachment stats                         # how much is searchable inside

./bank contact add alice                        # one person, many identities
./bank contact alias add alice alice@example.com "whatsapp:Alice" discord:alice_x
./bank contact messages alice                   # everything she sent or received
./bank contact import contacts.json             # a whole contact book at once

./bank search "that invoice" --from alice --since 2024-01-01
./bank search "alice retainer" --match all        # every word, across searchable fields
./bank search "quarterly review" --match phrase   # adjacent words in this order
./bank search "retainer"                        # matches text inside PDFs and Office files
./bank search "the deck" --to bob               # by recipient
./bank search "that invoice" --person alice     # every identity she uses
./bank search "typo-tolerannt query" --json     # agents consume this
./bank search "invoice" --limit 50 --offset 50  # the next page
./bank show 42
./bank show c5e63bfc3750                        # the stable ref a citation carries
./bank show c5e63bfc3750 --provenance           # archived input and mail grouping evidence
./bank thread "Alice" --source whatsapp --around 42 --limit 100
                                                # context centered on a search hit
./bank thread "Alice" --source whatsapp --before 42 --limit 100
                                                # earlier messages, without a history cap
./bank stats                                    # counts, freshness, coverage notes
./bank coverage whatsapp "only the chats exported in 2025-08"
./bank query --schema                           # tables and columns, before the first query
./bank query "select source, count(*) from messages group by 1"
                                                # read-only ad-hoc SQL: READ ONLY tx,
                                                # 15s timeout, row cap — analytics only
./bank verify --heal                            # check the archive, repair what the raw inputs allow
./bank reimport chatgpt                         # replay archived exports through today's importer
./bank reimport mbox --heal-bodies              # dry run: mail whose archived raw parses longer
./bank reimport mbox --heal-bodies --apply      # write those bodies
```

## Remote use

When Postgres lives on a VPS, run the server there in a container (`COMPOSE_PROFILES=server docker compose up -d`, published on a Tailscale address — there is no TLS) and set two env vars on the laptop. `search`, `show`, `stats`, `import` and `fetch` then go over HTTP, so rows, blobs and raw archives always land on the same box.

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
# through the server's own image, so the digest lands in the file it reads
export BANK_TOKEN=$(ssh vps 'cd /opt/aqt/apps/bank && docker compose run --rm -T bank token new laptop')

./bank import whatsapp "WhatsApp Chat with Alice.zip"   # uploaded to the VPS
./bank fetch 9f86d081... -o photo.jpg                   # attachment bytes back
```

`bank ui` opens a local archive browser (search, thread-grouped browse, contacts, stats) at `127.0.0.1:8481`. It needs `BANK_URL`/`BANK_TOKEN` and attaches the token server-side, so it never reaches the browser. The page is a Vite + React + shadcn/ui app in `internal/webui/app`; its built `dist/` is committed and embedded, so `go build` needs no JS toolchain — after changing the app, rebuild with `bun run build` there.

Stats shows each source's last import, recorded sync checkpoint, and coverage note.
Sources flagged as stale by the API show **No recent imports**. A recent sync does
not imply that new messages were imported.

Run `bun run check:dist` in `internal/webui/app` to rebuild and check the embedded
assets against Git. Commit the rebuilt `dist/` with its source changes. CI and
`mise run bank:ts` run the same check.

Agents on a client machine get the CLI handed to them by a Claude Code skill: [skill/README.md](skill/README.md).

Deployment (VPS, LUKS, containerized server, restic, cron): [DEPLOY.md](DEPLOY.md).

Attachments can contain any file type. Gmail sync and EML/MBOX imports preserve MIME attachments, including inline images. A link to a cloud-hosted file is still a link; Bank does not download its target.

Gmail retries reconcile attachments even when the message row already exists. To repair earlier partial imports, run `bank sync --full` on the server. This re-fetches existing mail and can take as long as the original backfill; normal syncs use history deltas.

ChatGPT imports preserve referenced assets included in the full export ZIP or directory. Importing only `conversations.json` imports text without the asset files. Missing files appear in the import's missing-media count. Reimporting a fuller export fills missing attachments even when a message already has some files, without duplicating those files.

Attachment storage and text extraction have different coverage. Audio, video, archives, and other binary files can be stored and downloaded without searchable contents. Supported document attachments are searchable inside. Importing reads text out of PDFs, Office and OpenDocument files, HTML and plain text, keyed on the blob digest so a document attached to forty messages is read once.

Scanned pages and images hold no text layer, so they are recorded as `needs_ocr` rather than guessed at. `bank extract --ocr` reads them wherever tesseract is installed: on the deployed box that is a worker draining the queue on a timer, turned on by adding `ocr` to `COMPOSE_PROFILES`. `bank attachment text <sha256> --set` takes a transcription from anywhere else, including a model running on the client, and marks it `manual` so no later pass overwrites it. `BANK_EXTRACT=off` or `bank import --no-extract` leaves attachment text alone entirely.

Config via env (see `.env.example`): `DATABASE_URL`, `BANK_DATA_DIR` (blobs, raw archives, inbox; default `~/.local/share/aqt-bank`), `BANK_EXTRACT`.

For automatic IMAP collection from Proton Bridge, Gmail or another provider,
see [IMAP.md](IMAP.md) and [imap.example.json](imap.example.json). The collector
runs beside Bridge or on another client machine and uploads to `BANK_URL`.
It keeps local checkpoints, retries failures and preserves mailbox read flags.

Schema migrations are embedded and run automatically through Tern on startup.
Existing filename-based history is checked and baselined once without replaying
applied migrations. See [DEPLOY.md](DEPLOY.md) before upgrading.

Ad-hoc SQL requires `BANK_QUERY_DATABASE_URL`, a separate restricted login created
with [deploy/query-role.sql](deploy/query-role.sql). It never falls back to the
import connection. The login has SELECT on public tables and sequences, schema USAGE, and no write,
server-file, program-execution, or administrative grants. READ ONLY transactions,
a 15-second timeout and a row cap provide additional limits. Other read commands
work without this setting.

## Retrieve conversation history

`bank thread` returns a chronological page with `has_before` and `has_after` in JSON. Use `--around <message-id>` to include a search hit, `--latest` to start at the newest messages, or `--before` and `--after` with a page's first and last message IDs. These positions are mutually exclusive. Each page contains up to 2,000 messages and includes attachment metadata.

The browser opens search results around the matching message and provides **Load earlier** and **Load later** controls. Browse opens the newest page. Contact history also has **Load earlier**; CLI callers can use `bank contact messages <name> --before <message-id>` to continue beyond the offset limit.

LinkedIn conversations use the export's conversation ID. Run `bank reimport linkedin` on the server after upgrading to repair previously title-keyed conversations. It preserves message IDs and bodies.

## Check database behavior

`go test -race ./...` uses pgtestdb to clone a private database per test on the disposable ParadeDB server in `BANK_TEST_DATABASE_URL`. The tests never read `DATABASE_URL`, so exporting it for the CLI cannot point them at the archive. The configured login must be a superuser so it can create databases, install the search extension and provision a restricted query-test login. Local tests skip database cases when `BANK_TEST_DATABASE_URL` is unset or no server is listening, unless `CI` is set. CI always requires the database and starts the same pinned ParadeDB image as Compose. `mise run bank:check` also runs the shared `packages/go/pgschema` tests, which read `PGSCHEMA_TEST_DATABASE_URL`; it can name the same disposable server.

The retrieval cases in `internal/store/search_quality_integration_test.go` check exact and fuzzy ranking, all-word matches across fields, phrase order, and attachment-only matches. Run them with `go test ./internal/store -run TestSearchRetrievalCases`.

## Import reports, files, and branches

The browser's **Imports** tab keeps every import attempt, including failures and
unfinished runs. Reports record messages inserted, duplicates, newly preserved
files counted by content hash, missing media, unsupported content, and parser
diagnostics where the importer provides them. Unmeasured counters say
"Not measured". Reports start with imports made after this update; earlier
imports have no historical report. Reimporting creates a new report and keeps
the previous one.

```sh
bank reports --json
bank reports --before 42 --limit 50
bank attachment find --filename invoice --type pdf --person alice --since 2025-01-01
bank attachment find --text "payment due" --type pdf
bank attachment messages <sha256> --offset 0 --limit 50
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

Reimport existing ChatGPT exports to fill in branch metadata. Reimporting keeps
message IDs and existing bodies. A bare ChatGPT JSON export retains asset-only
messages and reports their missing files; importing the full export later can
restore those attachments.
