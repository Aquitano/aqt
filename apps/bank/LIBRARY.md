# Bank library

Bank stores media, activity, collections, personal tracking state, and files alongside its existing correspondence archive. Brain keeps authored Markdown. Bank can index a selected copy for combined search.

## Storage and ownership

| Content                                                                     | Canonical storage                                               | Search and editing                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Email, chats, personal AI conversations                                     | Existing Postgres message tables and stored raw inputs          | Existing message, thread, contact, attachment, and mail APIs                |
| Movies, series, episodes, videos, tracks, albums, podcasts, books, articles | `library_items`                                                 | Typed identity and metadata, with a separate personal state                 |
| Watching, listening, reading, playing, viewing, purchases                   | `library_activity`                                              | Source observations with a day, instant, or unknown date                    |
| Imported playlists and music libraries                                      | `library_collections`, `library_snapshots`, `library_entries`   | Immutable snapshots preserve order, duplicate entries, and completeness     |
| Personal playlists and watchlists                                           | The collection tables and revision history                      | Editable membership and order with conflict detection                       |
| Status, progress, rating, favorites, notes, tags                            | `library_state`, `library_state_edits`                          | Imports cannot overwrite these fields                                       |
| Standalone files and media files                                            | `library_files` metadata; `BANK_DATA_DIR/blobs` for bytes       | Multiple files can belong to an item; identical bytes share one BLAKE3 blob |
| Selected Brain pages                                                        | Original Markdown in Brain; published copies in `library_pages` | Searchable title, body, answers, aliases, and tags; no write-back to Brain  |
| Source exports                                                              | `raw_inputs` rows; `BANK_DATA_DIR/blobs` for bytes              | Immutable inputs referenced by imported records                             |

The SVG diagrams and web UI are views. They do not hold the archive. Back up the database and the complete Bank data directory together. A database export alone omits file bytes. Raw exports alone omit your ratings and personal collections.

There is no new service or second search database. The existing Go binary serves the API and embedded React UI. Postgres stores structured records, and the existing blob store holds files.

Library imports and Markdown publications are stored as raw inputs before they are parsed, like correspondence. `bank reimport` replays them with the rest.

## Import media and files

```sh
bank import netflix NetflixViewingHistory.csv --account thomas
bank import netflix NetflixViewingHistory.csv --account thomas --date-order dmy
bank import youtube-media takeout.zip --account thomas
bank library upload film.mp4 soundtrack.flac notes.pdf
bank library upload cover.jpg subtitles.srt --item-id item:<32 hex>
bank import library bundle.json
```

Keep `--account` stable for a profile or provider account. Identities use the source, account, and source record ID. Two accounts can import the same provider title without overwriting each other's records. Provider IDs remain searchable metadata. Bank does not automatically merge titles across source or account identities. Reimports retain earlier source references in `library_item_evidence`, so metadata enriched from several exports keeps its provenance.

The Netflix importer accepts CSV `Title` and `Date` columns. Slash dates default to month-first. Use `--date-order dmy` for day-first slash dates. ISO dates, timestamps, and dotted day-first dates retain their existing interpretation. Day-only dates stay day-only. A viewing row does not mark a series complete.

Netflix supplies no stable event ID in this export. Bank identifies observations by their exact title, date, and occurrence number within matching rows. Reordered and overlapping exports reuse these identities while repeated rows within one export remain separate observations. Localized or changed titles remain separate identities.

The `youtube-media` importer reads Takeout ZIP files, extracted directories, watch-history JSON or HTML, and supported playlist or music library CSV/JSON files. Selected input bytes are limited to 512 MiB in total. It prefers JSON history when both history formats exist. Playlist snapshots preserve repeated songs, exported positions, and complete, partial, or unknown coverage. The existing `youtube` importer remains available for its message representation.

HTML timestamp parsing depends on the importing machine's timezone. Prefer JSON history when moving imports between machines with different timezone settings. Replaying HTML history on a machine in another timezone conflicts with the activity already stored.

The local inbox accepts `netflix`, `youtube-media`, and `library` directories in addition to its existing source directories. Use direct imports with `--account` for multiple profiles. The CLI packs a directory into one ZIP before it imports or uploads it.

Files upload in batches of up to 100. The API streams their bytes into the existing blob store. Each upload queues a text job that reads PDF and Office text. Scanned files wait in the OCR queue for `bank worker --queue ocr`. Previews validate file bytes. Supported image and PDF files can preview in the UI. Audio previews include MP3, FLAC, and AAC, and playback depends on the browser's codec support. Supported video formats can also preview. Other files remain downloadable and searchable when text is available.

## Publish Brain pages for search

```sh
bank library index ~/brain/wiki --source brain --account wiki
bank search "what did I think about that film" --json
```

With `BANK_URL` set, the command scans locally and sends selected page bytes and validated metadata to Bank. It never asks the server to read a local filesystem path.

Each publication replaces the indexed pages for its exact source and account. Use one publisher for each source and account pair. The last successful full publication wins, and Bank does not reject an older publication based on its revision. Deleted, excluded, and newly restricted pages disappear from that search projection. A failed scan or invalid publication leaves the prior publication intact. Each publication is stored as a raw input of kind `markdown`, so earlier publications stay in the blob store.

The scanner excludes hidden directories, raw archives, generated Brain render pages, and pages marked `origin: bank`. It publishes normal pages by default. `--max-sensitivity personal` includes personal pages. Confidential pages require `--allow-confidential` and the corresponding sensitivity selection. Existing health, journal, and self paths receive conservative defaults when frontmatter omits sensitivity. Prefer explicit `sensitivity:` on pages whose classification matters.

Publications accept at most 32 MiB of encoded data. Each page accepts at most 8 MiB. Split larger vaults into explicitly selected directories with separate stable account names. The default account is derived from the selected directory path; `--account wiki` keeps identity stable across machines and directory moves.

Bank searches the most recent successful publication. Changes in Brain are visible after indexing again. A Brain query that requires unpublished or freshly edited material must still run Brain's local search. The Bank `pages` results include the original path and content hash so agents can distinguish an indexed copy from a current file. A page revision is its content hash, not a Git commit or a freshness guarantee.

## Query and edit

`bank ref <ref>` says what any cited ref names: `msg:<16 hex>` for a message, a library ID such as `item:<32 hex>`, or `content:<16 to 64 hex>` for bytes. A bare value without its kind is rejected. It prints the record's kind and title, the route that returns it in full, and where the same bytes are. A message or library file lists the places on disks that hold its bytes; bytes list the messages and library files that hold them and the places on disks.

Message attachments, library files and files on disks share one `contents` row per BLAKE3 digest, so these links need no background pass and appear as soon as an import or a scan commits.

`bank timeline 2019-03` lists what happened in a year, a month or a day, oldest first: messages by when they were sent, activity by when it happened, and files on disks by when they were last modified. `--group message`, `activity` or `file` narrows it. `--limit` caps each group on its own, so a day with thousands of files cannot push the messages out, and the output names the groups that reached it. Activity without a date and files that have gone missing are left out.

`bank search` and the UI Search tab return separate groups for correspondence, media, activity, collections, files, message attachments, and published pages. `bank search` adds the files [attic](attic/README.md) catalogues on disks, cited as `content:<hex>`: names and paths, archive members, document text, embedded tags and OCR. `--match` means the same there as for every other group; a phrase search leaves files on disks out, because they are matched by words. It is left out when a sender, source, account, date or a kind other than `file` narrows the search, and when the catalogue cannot answer, which `coverage` then says. Each group has its own bounded page. A message hit carries its `msg:` ref for `bank show`.

```sh
bank search "arrival" --json
bank search "arrival" --kind movie --json
bank search "invoice" --from alice --since 2025-01-01
bank library list --kind track --source youtube
bank library activity --source netflix --account thomas
bank library collections --kind playlist
bank library get item:<32 hex>
bank library get activity:<32 hex>
bank library snapshots collection:<32 hex>
```

A library record's ID is its ref. `bank library get` takes any of them and picks the record kind from it: `item:`, `activity:`, `collection:`, `file:` or `page:`.

Correspondence-specific filters such as sender, recipient, mailbox, and contact restrict combined search to correspondence. Account filters restrict it to the library because mail has a different account model. Message fuzzy matching stays in ParadeDB; library text search uses Postgres full-text indexes. Scores from these indexes are not treated as comparable. Date filters apply to correspondence, dated activity, and message attachments. Items, collections, standalone files, and pages have no event date, so they remain unfiltered by those dates. Undated activity is excluded when a date filter is present. Bank rejects combinations of correspondence filters with a library kind or account.

Pages, notes and extracted text retain their full contents when they exceed PostgreSQL's vector limit. Search parses the selected oversized text for each query, so its cost grows with those documents.

The UI can add titles, edit personal tracking state, create playlists and watchlists, reorder entries, copy imported collections into personal ones, upload files, and inspect imported history. Imported playlists stay read-only so an export and a personal edit cannot silently replace each other.

CLI edits accept JSON from a file or standard input. State and collection edits require `expected_revision` from the latest record. A stale write returns a conflict instead of replacing newer work. Ratings range from 1 to 5. Progress uses an explicit unit such as episodes, pages, seconds, or percent.

```json
{
  "expected_revision": 0,
  "status": "planned",
  "favorite": false,
  "progress": 0,
  "progress_unit": "",
  "rating": 4,
  "notes": "Recommended by a friend.",
  "tags": ["weekend"]
}
```

Apply that document with `bank library state item:<32 hex> state.json`. State edits replace the complete personal state, so include fields you want to retain.

## Retire messages a library import replaces

YouTube history that reached Bank as generic JSON lives in `messages` under external ids such as `watch:`, `playlist:` and `library-song:`. Once `bank import youtube-media` holds the same history as library records, `bank retire` deletes those message rows. Each deleted row leaves a tombstone in `message_tombstones` with its source, external ID, Message-ID, ref, date, subject, raw input, reason and optional replacement library ID.

Every message import skips a tombstoned source and external ID, and for mail a tombstoned Message-ID, so a JSON re-upload, `bank reimport` or an inbox sweep cannot bring the row back; every import counts it as retired. `bank show <ref>` for a retired ref prints the tombstone and its replacement instead of failing. Over HTTP, `GET /v1/messages/{ref}` answers `410 Gone` with the tombstone under `retired`.

Run the cutover on the server. `retire` refuses to run through `BANK_URL`.

1. Back up with `docker-backup bank` or the `pg_dump` block in [DEPLOY.md](DEPLOY.md) §7. The delete has no undo except that dump.
2. Import every Takeout: `bank import youtube-media takeout.zip --account thomas`.
3. Compare counts per kind: `bank query "select split_part(external_id, ':', 1), count(*) from messages where source = 'youtube' group by 1"` against `bank query "select kind, count(*) from library_activity where source = 'youtube' group by 1"` and the collection snapshots. Spot-check a few titles with `bank search`.
4. Build the replacement map for every cited ref. `bank show <ref> --json` says what the message was; `bank search "<title>" --json` or `bank library activity "<title>" --source youtube` finds the library record. Write a CSV of `ref,replacement` rows, or a JSON object of ref to ID, with refs in their `msg:` form, into `BANK_DATA_DIR` so the container sees it under `/data`. Replacements must be existing item, activity or collection IDs.
5. Dry run: `bank retire --source youtube --external-prefix watch: --external-prefix playlist: --external-prefix library-song: --replacement-map /data/youtube-refs.csv --reason "replaced by youtube-media"`. It prints counts and samples per prefix, and every map ref that matches no retiring row. Such a ref is a typo or a citation of a row this run keeps, and `--apply` refuses to run until the map has none.
6. Apply: repeat the command with `--apply`. One statement deletes the rows and writes their tombstones; attachment, mailbox and mail-thread rows follow through their cascades. Message imports wait until it commits, so none can bring a retired row back. Blobs and raw inputs stay.
7. Verify: `bank stats`, `bank show <cited ref>` reports it retired with its replacement, and `bank library get <replacement>` resolves. Then re-point the wiki citations to the library IDs.

## Extend and move Bank

The version 1 JSON library import format uses `internal/library.ImportBatch` with arrays of items, activity, collections, and files. The `pages` array must be empty. Publish Markdown with `bank library index` so Bank can verify original bytes and sensitivity before replacing its search projection. Importers parse provider exports into typed batches, which the store validates and commits atomically. Each file names its bytes by `blake3`, 64 lowercase hex characters, and must already exist in Bank's blob store with matching digest and size. Remote imports never dereference arbitrary server file paths.

A new provider normally needs an importer and fixtures. A new media kind or queryable field needs a typed model change, a SQL migration, and the relevant UI fields. Keep provider-only detail in the stored raw input until a real feature needs it. There is no plugin registry or unrestricted custom-field store to maintain.

For a machine move, preserve a consistent Postgres backup, the complete `BANK_DATA_DIR`, and the configuration that selects them. Restore with a compatible ParadeDB version, then run `bank verify`. It hashes every content that a message attachment, a library file or a raw input refers to, and reports missing bytes, digest mismatches and incorrect sizes. It repairs nothing. Existing deployment and backup procedures remain in [DEPLOY.md](DEPLOY.md). A Markdown publication is replaceable from Brain; personal state and collection revisions require the database backup.

This implementation does not move existing Brain watch registers or import private exports automatically. Cut those over only after importing their source data, comparing counts and examples, and preserving the original files. Bank becomes the owner of a tracker when its edits move to Bank, not merely because an index contains a copy.
