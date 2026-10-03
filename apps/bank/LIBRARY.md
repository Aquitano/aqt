# Bank library

Bank stores media, activity, collections, personal tracking state, and files alongside its existing correspondence archive. Brain keeps authored Markdown. Bank can index a selected copy for combined search.

## Storage and ownership

| Content                                                                     | Canonical storage                                               | Search and editing                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Email, chats, personal AI conversations                                     | Existing Postgres message tables and archived exports           | Existing message, thread, contact, attachment, and mail APIs                 |
| Movies, series, episodes, videos, tracks, albums, podcasts, books, articles | `library_items`                                                 | Typed identity and metadata, with a separate personal state                  |
| Watching, listening, reading, playing, viewing, purchases                   | `library_activity`                                              | Source observations with a day, instant, or unknown date                     |
| Imported playlists and music libraries                                      | `library_collections`, `library_snapshots`, `library_entries`   | Immutable snapshots preserve order, duplicate entries, and completeness      |
| Personal playlists and watchlists                                           | The collection tables and revision history                      | Editable membership and order with conflict detection                        |
| Status, progress, rating, favorites, notes, tags                            | `library_state`, `library_state_edits`                          | Imports cannot overwrite these fields                                        |
| Standalone files and media files                                            | `library_files` metadata; `BANK_DATA_DIR/blobs` for bytes       | Multiple files can belong to an item; identical bytes share one SHA-256 blob |
| Selected Brain pages                                                        | Original Markdown in Brain; published copies in `library_pages` | Searchable title, body, answers, aliases, and tags; no write-back to Brain   |
| Source exports                                                              | `BANK_DATA_DIR/archive`                                         | Immutable inputs referenced by imported records                              |

The SVG diagrams and web UI are views. They do not hold the archive. Back up the database and the complete Bank data directory together. A database export alone omits file bytes. Raw exports alone omit your ratings and personal collections.

There is no new service or second search database. The existing Go binary serves the API and embedded React UI. Postgres stores structured records, and the existing blob store holds files.

## Import media and files

```sh
bank import netflix NetflixViewingHistory.csv --account thomas
bank import youtube-media takeout.zip --account thomas
bank library upload film.mp4 soundtrack.flac notes.pdf
bank library upload cover.jpg subtitles.srt --item-id item_ID
bank import library bundle.json
```

Keep `--account` stable for a profile or provider account. Identities use the source, account, and source record ID. Two accounts can import the same provider title without overwriting each other's records. Provider IDs remain searchable metadata. Bank does not automatically merge titles across source or account identities. Reimports retain earlier source references in `library_item_evidence`, so metadata enriched from several exports keeps its provenance.

The Netflix importer accepts CSV `Title` and `Date` columns. Day-only dates stay day-only. A viewing row does not mark a series complete. Netflix supplies no stable event ID in this export, so replaying the same file deduplicates exactly; overlapping different exports can contain repeated observations. Import diagnostics state this limitation.

The `youtube-media` importer reads Takeout ZIP files, extracted directories, watch-history JSON or HTML, and supported playlist or music library CSV/JSON files. It prefers JSON history when both history formats exist. Playlist snapshots preserve repeated songs and distinguish complete, partial, and unknown exports. The existing `youtube` importer remains available for its message representation.

The local inbox accepts `netflix`, `youtube-media`, and `library` directories in addition to its existing source directories. Use direct imports with `--account` for multiple profiles. HTTP imports accept files; package a Takeout directory as a ZIP for a remote Bank.

Files upload in batches of up to 100. The API streams their bytes into the existing blob store. PDF and Office text extraction uses the existing extraction queue. OCR still uses `bank extract --ocr`. Supported image, PDF, audio, and video formats can preview in the UI; other files remain downloadable and searchable when text is available.

## Publish Brain pages for search

```sh
bank library index ~/brain/wiki --source brain --account wiki
bank search "what did I think about that film" --json
```

With `BANK_URL` set, the command scans locally and sends selected page bytes and validated metadata to Bank. It never asks the server to read a local filesystem path.

Each publication replaces the indexed pages for its exact source and account. Use one publisher for each source and account pair. The last successful full publication wins, and Bank does not reject an older publication based on its revision. Deleted, excluded, and newly restricted pages disappear from that search projection. A failed scan or invalid publication leaves the prior publication intact. Previously archived source bytes remain in the private raw archive.

The scanner excludes hidden directories, raw archives, generated Brain render pages, and pages marked `origin: bank`. It publishes normal pages by default. `--max-sensitivity personal` includes personal pages. Confidential pages require `--allow-confidential` and the corresponding sensitivity selection. Existing health, journal, and self paths receive conservative defaults when frontmatter omits sensitivity. Prefer explicit `sensitivity:` on pages whose classification matters.

Publications accept at most 32 MiB of encoded data. Each page accepts at most 8 MiB. Split larger vaults into explicitly selected directories with separate stable account names. The default account is derived from the selected directory path; `--account wiki` keeps identity stable across machines and directory moves.

Bank searches the most recent successful publication. Changes in Brain are visible after indexing again. A Brain query that requires unpublished or freshly edited material must still run Brain's local search. The Bank `pages` results include the original path and content hash so agents can distinguish an indexed copy from a current file. A page revision is its content hash, not a Git commit or a freshness guarantee.

## Query and edit

`bank search` and the UI Search tab return separate groups for correspondence, media, activity, collections, files, message attachments, and published pages. Each group has its own bounded page. Existing message citations still work with `bank show`.

```sh
bank search "arrival" --json
bank search "arrival" --kind movie --json
bank search "invoice" --from alice --since 2025-01-01
bank library list --kind track --source youtube
bank library activity --source netflix --account thomas
bank library collections --kind playlist
bank library get item_ID
bank library snapshots collection_ID
```

Correspondence-specific filters such as sender, recipient, mailbox, and contact restrict combined search to correspondence. Account filters restrict it to the library because mail has a different account model. Message fuzzy matching stays in ParadeDB; library text search uses Postgres full-text indexes. Scores from these indexes are not treated as comparable. Date filters apply to correspondence, dated activity, and message attachments. Items, collections, standalone files, and pages have no event date, so they remain unfiltered by those dates. Undated activity is excluded when a date filter is present. Bank rejects combinations of correspondence filters with a library kind or account.

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

Apply that document with `bank library state item_ID state.json`. State edits replace the complete personal state, so include fields you want to retain.

## Extend and move Bank

The version 1 JSON library import format uses `internal/library.ImportBatch` with arrays of items, activity, collections, and files. The `pages` array must be empty. Publish Markdown with `bank library index` so Bank can verify original bytes and sensitivity before replacing its search projection. Importers parse provider exports into typed batches, which the store validates and commits atomically. Files referenced by a bundle must already exist in Bank's blob store with matching hash and size. Remote imports never dereference arbitrary server file paths.

A new provider normally needs an importer and fixtures. A new media kind or queryable field needs a typed model change, a SQL migration, and the relevant UI fields. Keep provider-only detail in the archived source until a real feature needs it. There is no plugin registry or unrestricted custom-field store to maintain.

For a machine move, preserve a consistent Postgres backup, the complete `BANK_DATA_DIR`, and the configuration that selects them. Restore with a compatible ParadeDB version, then run `bank verify`. Verification checks standalone library blobs for missing bytes, incorrect sizes, and digest mismatches. It also checks retained item source references and every collection snapshot, including older ones. Raw filenames carrying a digest are checked against their bytes. Library damage is reported without automatic healing. Existing deployment and backup procedures remain in [DEPLOY.md](DEPLOY.md). A Markdown publication is replaceable from Brain; personal state and collection revisions require the database backup.

This implementation does not move existing Brain watch registers or import private exports automatically. Cut those over only after importing their source data, comparing counts and examples, and preserving the original files. Bank becomes the owner of a tracker when its edits move to Bank, not merely because an index contains a copy.
