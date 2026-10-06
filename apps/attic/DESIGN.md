# attic — search for files on disks that come and go

One index of every file on my backup disks and USB sticks, searchable from a CLI by me and my agents, including disks that are unplugged right now.

## Decisions (2026-10-06)

| Area          | Choice                                                                                                 | Why                                                                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Go, one `attic` binary                                                                                 | Same as bank, so text extraction is one shared package (`packages/go/extract`). One static binary for Windows now and macOS later                                                                                                                   |
| Store         | Postgres + ParadeDB `pg_search`, reached through `DATABASE_URL`                                        | A catalogue row and its BM25 entry commit in one transaction, so there is no second index to keep in step. attic stores nothing outside the database, so the CLI can talk to Postgres directly: there are no blobs that could land on the wrong box |
| Host          | The Windows desktop the disks attach to, ParadeDB in Docker Compose                                    | The disks plug in there. The VPS has neither the ports nor the memory                                                                                                                                                                               |
| Originals     | Never stored                                                                                           | attic is an index, not a backup. Every file gets metadata, documents get text, images get OCR and a short description                                                                                                                               |
| Scanned disks | Never written to                                                                                       | Volumes are recognised by a fingerprint, not a marker file. Last-access times are kept while hashing, listing and reading (see Scanning)                                                                                                            |
| Scanning      | Manual, `attic scan <path>`                                                                            | Disks come and go; nothing watches for them yet                                                                                                                                                                                                     |
| Code          | Source files keep a row with name and metadata; their contents are never read for text                 | Zoekt becomes the code search engine later. Old projects are mostly found by folder and file name ("the EngineAlpha project from school")                                                                                                           |
| Work          | Staged: the scan records metadata and a BLAKE3 hash, later stages are queues over deduplicated content | Text, OCR and descriptions are expensive. They run once per unique content, never per copy                                                                                                                                                          |
| AI            | Behind a provider interface: any OpenAI-compatible endpoint (Ollama locally) and `codex exec`          | Models change. Every result records provider, model and prompt version, so redoing it with a better model is a query                                                                                                                                |
| Secrets       | No scrubbing. A default "name only" pattern list keeps recovery-key files out of the text index        | The database is meant to live on encrypted storage. Plain-text BitLocker recovery keys sit at the root of both backup disks, and one config line keeps them out                                                                                     |

## Identity

Three identities, so a moved or copied file never costs a second hash, extraction or description.

**Volume.** attic gives each volume its own UUID and recognises it by fingerprint: file system type, serial (the full 64-bit serial on NTFS, 32 bits on FAT and exFAT), partition GUID, device serial and size. Drive letters are display only; in July the Data disk was `F:`, now it is `E:`. A sector clone shares every on-disk id but not the device serial, so a fingerprint whose serial matches while the device differs stops the scan and asks (`--volume <id>` or `--new-volume`) instead of guessing.

**Content.** BLAKE3-256 of the bytes plus the size, one row per unique content. Extracted text, OCR and descriptions attach here and nowhere else. Its ref, the first 16 hex characters of the hash, is the citation form (`attic:<ref>`) and survives moves, copies and database rebuilds. Sixteen rather than bank's twelve: at five million contents, twelve characters give about a 4% chance of two sharing a ref.

**Entry.** One row per place a file or folder lives: volume, parent, name, path, size, four timestamps, attributes, content.

- On NTFS the identity is the file reference number, which survives renames and moves within the volume. A rescan that meets a known file id at a new path updates that row, keeps its content and hashes nothing.
- On FAT and exFAT the identity is the path. Windows synthesises their file ids from directory-entry positions, so they move when files do.
- A file keeps its content while size, modified time and change time are unchanged. Change time catches writers that restore the modified time.
- Hard links share one file id across several paths; the last path seen wins. They are rare on backup disks.

**Hierarchy.** Every entry points to its parent folder and also carries its volume-relative path. Search ranks words from the path and the name together, and BM25 indexes one table, so the path has to be on the row. A folder move is one `update` over the subtree's path prefix, and folders on backup disks rarely move.

**Archives.** Member listings are keyed by the archive's content hash, so the same zip on three disks is listed once and a hit inside it shows all three copies. Members carry name, path, size, time, and CRC32 where the format has one (zip and 7z); they are never hashed. A nested archive's members sit below its path, joined with `::` (`MinecraftServer.rar :: world/level.dat`). Nesting stops at a configured depth; every archive not opened is a skip with its reason.

**Missing and moved** (later). Nothing is deleted yet. An entry that a complete scan of its folder no longer saw reads as missing. Reconciliation will match by file id, then path, then size, modified time and name, then hash, and will mark a file deleted only when its parent folder was read completely, never because a disk was unplugged or a read failed. The NTFS change journal can make rescans incremental, but reading it needs administrator rights, so it stays optional.

## Scanning

1. **Volume.** Resolve the path's volume and match its fingerprint.
2. **Walk.** One directory handle per folder. `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)` returns names, sizes, timestamps, attributes and file ids in bulk, with no open per file. Rows commit every couple of seconds, so search works while a scan runs.
3. **Hash.** Files without known content, in path order, one reader by default because USB hard disks punish parallel reads. The listing already recorded each file's last-access time. Reading opens the file with attribute access and calls `SetFileTime` with `-1`, which stops Windows updating last access through that handle. Write-protected media refuses that open, and the read falls back to a plain one.
4. **Archives.** Hashed files named like an archive (zip, 7z, rar, tar and compressed tars) whose content has no listing yet, in path order. The leading bytes decide the format. Go readers ([mholt/archives](https://github.com/mholt/archives) for zip, 7z and tar, rardecode for rar) read through the same last-access-preserving handle as hashing; 7-Zip would open the files itself, and this machine has last-access updates enabled. A nested archive is copied to the temporary folder on C:, listed and deleted at once, and a scan refuses to start when that folder is on the disk it scans; one larger than `unpack_max_bytes` stays a plain member. Rar is read from its headers alone. Reaching a nested archive inside a solid 7z or rar decodes everything stored before it, which can take as long as reading the whole archive. Each listing commits in its own transaction, so an interrupted one is redone, never half kept. Zip names that are not valid UTF-8 are read as code page 850, which Western European Windows writes without the UTF-8 flag.
5. **Text.** Hashed documents whose content has no text yet, in path order: plain text, Markdown, CSV, HTML, Office and OpenDocument files, and PDF text layers, read with `packages/go/extract` through the same last-access-preserving opener. JSON, YAML, SQL, INI and other configuration count as source code and keep their names only, and so do logs. Documents up to `text.max_bytes` are read and the first 1 MB of each one's text is kept; a longer one reads as `truncated`, searchable like `ok`. A PDF without a text layer reads as `needs_ocr`, the queue for step 5. A document that cannot be read is a `text_failed` skip and is not retried.
6. **Skips.** Everything not indexed, not hashed, not opened or not read (excluded pattern, access denied, reparse point, read error, size cap, too deep, encrypted, damaged, unreadable document) is a row in `skips` with its reason, for `attic skips` to review.

Interrupting a scan is safe. Running it again walks again, which takes minutes, and hashes, lists and reads only what is still pending.

An archive reads as one of: listed; damaged, keeping whatever members were read before the damage (none for rar, which lists from its headers in one go); encrypted, when even the names are; not an archive; or split, a later volume of a multi-volume rar, which is listed with its first volume. A read that fails says something about the disk, not the archive: the listing is dropped and tried again on the next scan, and so is a first volume whose other parts are not beside it. Passwords are never asked for. Picocrypt files and other encrypted containers stay plain files.

Git repository roots are recorded with their `origin` remote, the list Zoekt will start from. `.git` itself is excluded.

## Config

One TOML file at `<UserConfigDir>/attic/config.toml` (`%APPDATA%\attic\config.toml` on Windows), or another one for a single run with `--config`. Patterns use gitignore syntax. Built-in defaults exclude dependency and build output, game libraries, and Windows system folders and files. Configured patterns come after the defaults, so `!pattern` re-includes something. A `[[volume]]` block anchors its patterns at that volume's root.

```toml
exclude = ["*.iso"]
name_only = ["*.kdbx"]
hash_max_bytes = 0 # 0 hashes every file

[archives]
depth = 2                      # archive levels opened, the one on disk included; 0 reads none
unpack_max_bytes = 4294967296  # largest nested archive copied out to be listed; 0 is no limit
temp = ""                      # where nested archives are copied; the system temp folder when empty

[text]
max_bytes = 67108864           # largest document read for its words; 0 is no limit

[[volume]]
label = "Data"
exclude = ["/Games/"]
```

`attic config` prints the effective configuration. A listing is kept once made, so raising `depth` later does not reopen archives already listed.

## CLI

```
attic scan <folder> [--config f] [--no-hash] [--volume id | --new-volume] [--json]
attic search [words] [--any] [--volume v] [--ext e] [--kind file|dir|link] [--under path] [--limit n] [--offset n] [--json]
attic show <id|ref> [--json]
attic text <id|ref> [--json]
attic volumes [--json]
attic dupes [--min-size 1M] [--same-volume] [--limit n] [--json]
attic skips [--scan id | --volume v] [--reason r] [--rule r] [--limit n] [--json]
attic stats [--json]
attic config [--config f] [--volume v]
```

Search needs every word by default, each matching the name, the path, or a fragment of the name; `--any` relaxes that. Files inside archives come after the plain hits and matching documents after those, each ranked on its own because the BM25 indexes score on different scales; their words must match within the archive, not the archive's own path. `--volume` and `--under` filter where the archive lives, and `--under` naming an archive lists what it holds. Copies on two backup disks are usually deliberate, so `dupes --same-volume` counts only copies that share a disk.

## Steps

1. **Scan.** Volume fingerprints, bulk NTFS listing, hierarchy, BLAKE3, config and exclusions, skips, `search`, `show`, `volumes`, `dupes`, `stats`. Done when E: is scanned completely, searchable during the scan, and still searchable with E: unplugged.
2. **Archives.** Listings through Go readers, keyed by archive content, with a nesting limit.
3. **Text.** `packages/go/extract` split out of bank (`File`, statuses, OCR and `StripHTML` move; bank's queue stays, as `internal/blobtext`), bank switched in the same change. Text capped at 1 MB per file. attic records a `truncated` status, so the first full scan shows how much goes over; the package reports it as a flag on an `ok` result, because bank's indexes and queries key on `ok`. Source code is never read.
4. **Metadata.** exiftool in batch mode for images, PDFs, Office files, audio and video; Go readers where they are trivial.
5. **AI.** The provider interface, OCR and image descriptions. The local vision model is chosen by testing candidates on my own images; `codex exec` is opt-in for small selections.

Later: Zoekt over the recorded repository roots, move and delete reconciliation, the change journal, scanning on macOS, remote access.

## Where Postgres lives

Docker Compose on the desktop for now. On 2026-10-06 C: had 31 GB free and Docker's disk image was already 68 GB, so the final home is decided once scanning E: shows real sizes. Moving it is a `DATABASE_URL` change.
