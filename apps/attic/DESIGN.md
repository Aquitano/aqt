# Attic's catalogue model

Attic indexes disks that are connected only occasionally. Search uses the catalogue without opening a source disk. A later scan reconciles what the disk contains with the recorded entries. PostgreSQL stores the catalogue; ParadeDB supplies BM25 search.

Usage and configuration live in [README.md](README.md). `attic help <command>` describes command arguments.

## A place and its content have different identities

An entry identifies a filesystem object at a place on one volume. A content row identifies bytes by their full BLAKE3 digest. Multiple entries can point to one content row. Public content refs use the first eight digest bytes, so refs identify content rather than paths.

Volume fingerprints combine the filesystem and volume serial with available partition and hardware identifiers. A sector clone can share filesystem and partition identity. Automatic resolution requires enough hardware identity to avoid silently merging it into the original catalogue. Missing or conflicting device serials require `--volume` or `--new-volume`; enclosure changes can require the same decision.

On NTFS and ReFS, stable file IDs let an entry retain its identity across moves. FAT and exFAT use the parent and lossless filename identity because their synthesized file IDs can change when directory entries move. Display and search names are valid Unicode; filename identity preserves bytes that Unicode cleaning would otherwise merge.

Hard links identify one filesystem object through several paths. Entries retain their separate places, while stable object identity and matching size and timestamps allow hash reuse within the scanned subtree. Size or timestamp changes invalidate known content. Single-file moves retain their hash because NTFS can change the change time on a rename. Moves involving hard links require verification because another path can already hold newer bytes. A scan covering conflicting hard links rechecks their bytes.

## Versions keep earlier content searchable

The catalogue is a permanent history, so a file whose bytes change keeps what was read from its earlier content. `entry_versions` records each content an entry held, with its size and modified time, the scan that first saw it and the scan that saw it replaced. The earlier bytes are not kept, and nothing is deleted. Entries catalogued before version history start with one version whose first scan is the entry's last update, which can be later than the scan that hashed it.

A listing that resets an entry's content closes its open version. Hashing opens a version for the new content. When the latest version holds the same bytes, hashing reopens that version, so a touch, a save-via-rename or a hard-link check that rehashes unchanged bytes keeps one version. Moves and renames that keep their content never reach the version table. A missing entry keeps its open version, because missing is recorded on the entry.

Every content an entry holds has an open version, so content searches reach current and earlier contents through one `EXISTS` over the versions. Postgres plans that as a semi join. An `OR` of an entry `EXISTS` and a version `EXISTS` became hashed subplans that read the whole version table. `--current` keeps the original entry-only `EXISTS`. Place lists derive the flag from the entry: current while it points at the content, previous otherwise.

## Ancestry determines what moves or disappears

Every entry records its parent and its volume-relative path. The path is also indexed because filename and path words contribute to search ranking. Moving a directory updates descendants by parent ancestry. Path-prefix matching alone cannot distinguish directories during backup rotations or swaps.

Only a complete directory listing can mark an unseen entry missing. Unreadable and excluded directories leave their recorded descendants untouched. When a directory becomes a file or link, its descendants become missing. Rows remain available as history. Finishing a scan counts its remaining missing entries because an entry marked missing early can reappear elsewhere later in the scan.

## Verification preserves the catalogue baseline

`verify --under` is an explicit maintenance command, independent of scans and file changes. It streams selected entries from one catalogue query and rereads ordinary files against their full stored digests. Missing and unhashed entries remain in the selection. Each path is checked separately, including hard links and duplicate contents. The command does not update hashes or derived results. A mismatch only establishes that the bytes read differ from the baseline.

Verification requires an explicit subtree and resolves its mounted volume without updating volume identity. Ambiguous identity requires `--volume`. File opens refuse links and placeholders, including ancestor links. Results stream as files finish; cancellation keeps emitted results and marks the summary incomplete.

During a maintenance run, Windows rechecks the mounted fingerprint before each file so a removed or replaced disk is not treated as the selected copy. This adds work for small files but keeps the identity check on every read. Reports can be retained outside the catalogue; no persistent verification status or scheduler is maintained by Attic.

## Derived results must describe verified bytes

Archive listings, document text and metadata belong to content. Once a result exists, copies on other disks reuse it. This makes attaching a result to the wrong digest a persistent catalogue error.

The scanner verifies source bytes against the expected digest before extracting content-derived results. Readers and external tools use stable temporary copies. Changed files, failed reads and size limits leave work eligible for a later scan. A repeatable parser failure can be stored as a result of the verified content.

`scan --rebuild-content` discards archive listings and document text selected through present files below the scan root, then extracts them again. It repairs results produced before verification was enforced. The reset affects all copies sharing that content, and keeps metadata and enrichment results.

Temporary copies and nested archives use private `aqt-attic/scan-*` workspaces under the configured `temp` directory. Windows checks that scratch is off the source volume. File locks distinguish abandoned workspaces from active readers. Cleanup failures leave files available for a later cleanup attempt.

Archive members carry names, paths, sizes, timestamps and CRC32 where available. They are not independently hashed. A nested archive adds another `::` path component. Depth and unpack limits bound traversal. Multipart RAR listings need their sibling volumes; a missing part remains retryable. Archive listings commit as a unit so interruption cannot preserve a partial transaction.

Document extraction keeps at most 1 MB of text per content. PDFs without a text layer become `needs_ocr`. Source code, configuration and logs keep their names without text extraction. ExifTool handles embedded metadata separately from document text.

## Scans and enrichment have separate lifecycles

A volume-scoped advisory lock prevents scans of one volume from interleaving identity decisions. Directory and hash work commits periodically so searches see progress and interruption keeps completed work. Hashing follows path order to avoid unnecessary seeking on USB hard disks. Metadata extraction processes bounded batches, which differ from the per-file archive and document work.

Enrichment is an explicit command. Its provider interface exposes the task, model, extraction policy, supported extensions and one-file reader. Tesseract performs local OCR. OpenAI-compatible HTTP sends inline images. Optional Codex CLI execution uses restricted ephemeral sessions.

Enrichment results retain content, task, provider, endpoint, model and policy identity. Language, page limits and output limits affect the policy. A content-policy lock prevents duplicate concurrent calls. Each completed result commits independently. New work precedes failed retries; provider-wide outages stop the selection. A failed forced attempt preserves a prior successful result.

## Search groups preserve their own ranking

Filename, archive-member, document-text, metadata and enrichment indexes rank separately because their BM25 scores are not comparable. Content results include earlier versions unless `--current` is set; filename results describe entries as they are now. Every searchable word must match within one result unless `--any` is set. Query pieces with no searchable terms must not turn an otherwise valid every-word query into an empty match.

Entry extensions describe files; archive-member extensions describe members. Volume and folder filters identify where the enclosing file lives. An archive named by `--under` includes its members. Copy lists retain the same filters as the search result.

Volume, kind and extension are entry BM25 fields, so ParadeDB can apply those filters inside the index scan. Subtree filters use the entry path range. Ranked entries and archive members break equal scores by ID. Wordless searches retain path order. The ranked entry page is selected before joining volumes and contents, so ParadeDB can stop after the requested page instead of returning every match for Postgres to sort.

## The CLI and the API return one shape

`internal/view` turns catalogue records into what readers receive: every place says whether its disk is attached to this machine and how to open it. `--json` and the HTTP API both return those types, and the API's OpenAPI document is generated from them, so a field added for one reader reaches the other. Errors differ on purpose: the API gives each failure a `_tag` and its own schema so agent code can branch on it, while the CLI prints the message.

## Dedupe sets copies aside and never deletes

A copy leaves its place only when a copy inside the kept folders and the copy itself both hash to the catalogued digest at that moment, so a file that changed since its scan is never treated as a duplicate. The move is a rename into `.attic-quarantine` on the same disk that never replaces a file: it frees no space yet, and it cannot lose bytes. After the move, attic opens the quarantined file again without following links and requires the hashed bytes, unwritten since: the same file, or a second hash where FAT and exFAT gave the moved file a new ID. Anything else goes back. Before each move, the kept copy and both disks must still be the ones checked at the start. Deleting stays a person's decision, for once the kept copy is backed up off-site. Each move is recorded against the entry before the command reports success; a move that cannot be recorded is undone, unless the original path was taken meanwhile, and then the error names where the copy stayed.
