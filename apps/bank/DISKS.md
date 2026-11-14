# Files on disks

Bank also catalogues the files on backup disks and USB sticks, so they can be searched while unplugged. The catalogue stores file metadata, BLAKE3 hashes, archive listings, document text, embedded tags and OCR in the same database as the archive. A file on a disk, a message attachment and a library file with the same bytes share one `contents` row, and so share the text read from them: a document bank already read is not read again by a scan, and the reverse.

`bank disk` holds the commands that run on the machine the disks attach to. Like every other command, they reach the catalogue only through bank's API: over HTTP to `bank serve` when `BANK_URL` is set, and otherwise through the same handler served in process from `DATABASE_URL`. The machine with the disks needs no database credentials. The commands change source files only when `bank disk dedupe apply` moves duplicate copies into a quarantine folder, or `bank disk organize apply` and `undo` rename files and folders that a reviewed plan lists.

## Setup

The catalogue's tables are part of bank's schema, and `bank migrate` creates them. On the PC the disks attach to, set the two variables every remote `bank` command uses ([DEPLOY.md](DEPLOY.md#5-remote-cli-bank-serve) sets up the server), and give the PC a write token of its own:

```powershell
go build -o "$env:USERPROFILE\.local\bin\bank.exe" ./cmd/bank     # in apps/bank
[Environment]::SetEnvironmentVariable('BANK_URL', 'http://vps.tailnet.ts.net:8480', 'User')
[Environment]::SetEnvironmentVariable('BANK_TOKEN', '<a token from bank token new pc>', 'User')
```

Build bank from the same commit as bank serve, because the operations the disk commands send change with the API. A read-only token can search, list and verify, and answers `Forbidden` for a scan, a dedupe move or an enrichment result.

On a machine with the database, such as a development box, leave `BANK_URL` unset and every `bank disk` command serves the API in process from `DATABASE_URL`, with the same requests and the same output. Use `127.0.0.1` rather than `localhost` in that URL: the database listens on IPv4 only, and on Windows a `localhost` connection first spends about a second on IPv6.

Install ExifTool for embedded metadata. Poppler's `pdftotext` provides a fallback when the PDF text parser fails. OCR also needs Tesseract and Poppler's `pdftoppm`. Missing ExifTool leaves metadata pending and records `metadata_unavailable`; the rest of the scan continues.

## Use

```powershell
bank disk scan E:\
bank disk scan E:\Files --no-hash
bank disk search minecraft server
bank disk search werkstudent --ext pdf
bank disk search notes --under E:\Files --json
bank disk search minecraft lobby --current
bank disk search --under E:\Backups\Minecraft.7z
bank disk entry 36331
bank show content:3f9a1c2b4d5e6f70
bank disk get 36331 --to C:\Recovered\document.pdf --json
bank show content:3f9a1c2b4d5e6f70 --text
bank show content:3f9a1c2b4d5e6f70 --metadata
bank disk volumes
bank disk scans --volume Data
bank disk dupes --same-volume
bank disk redundancy --volume Data --under /Files
bank disk redundancy --volume Data --json --limit 50 --offset 0
bank disk skips --reason unreadable
bank stats
bank disk scan --help
```

To keep the catalogue current, run scans from a nightly task: [Scheduled scans](#scheduled-scans).

`bank disk search` requires every searchable word by default; `--any` accepts any word. Words can match names, paths or name fragments. Archive members, document text, metadata and enrichment results appear in separate ranked groups. `--volume` accepts a label or ID. `--under` accepts a mounted path, or a volume-relative path with `--volume`. All read commands support `--json`. `bank search` finds files on disks too, beside messages and the library, with `--kind file` to keep only files; `bank disk search` adds the filters only the catalogue has: volume, folder, extension, entry kind and current versions, and lists what they select without words.

Argument errors exit with code 2 and print the usage, as for every `bank` command. Command failures, including `bank disk enrich --task ocr` without targets or `--under`, exit with code 1.

An entry ID identifies a file at a place, and `bank disk entry <id>` shows it. A content ref such as `content:3f9a1c2b4d5e6f70` identifies its bytes across disks and the archive, and `bank show <ref>` lists the copies on disks and the messages and library files that hold the same bytes. Refs show 16 hex characters of the BLAKE3 digest; every command that takes a ref also accepts a longer prefix, up to all 64, always after `content:` and in lowercase. A bare digest is read as neither. If two contents share a ref, the command fails and lists each with a longer ref that tells them apart. Missing files remain searchable and are marked missing. `bank disk dupes --same-volume` counts copies that share a disk.

When a file's bytes change, the catalogue keeps what it read from the earlier content: archive listings, document text, metadata and enrichment results. The earlier bytes themselves are not kept. Archive-member, document-text, metadata and enrichment searches include these earlier versions by default. Text output marks such a place `previous version` and counts the other earlier holders as `held before`. In `--json`, every place of a content hit has `version` set to `current` or `previous`. A previous place shows the entry's path as it is now, with the size, modified time and ref it had then. `--current` leaves out content that no file holds now. Name and path search matches entries as they are now. `bank disk entry <id>` lists the entry's versions with the scans that first saw each one and saw it replaced. For files catalogued before version history, the first scan shown is the last scan that updated the entry, which can be later than the scan that first read its bytes. `bank show <ref>` lists the files that hold the content now, then those that held it before. Use `bank show <ref> --text` or `--metadata` to read an earlier version's results. Moves, renames and rehashing unchanged bytes keep one version.

`bank disk redundancy` selects present files in the requested scope and counts distinct volume IDs for their completed full content hashes across the entire catalogue. It reports content recorded on fewer than two volumes, with unique byte totals. Multiple paths and hard links on one volume count as one volume. Unknown and invalidated hashes appear separately, with path byte totals that cannot be deduplicated. Offline volumes count; entries marked missing do not. With no scope, it reports the whole catalogue.

Its totals include all selected content, independently of pagination. `--limit` and `--offset` page the content on a single volume and unknown-file lists separately. Each content lists up to 100 locations and its total path count. Location dates identify the recorded update scan's start, not a fresh verification. This read-only report does not rehash files or verify backup health or physical disk independence. Scans can be partial or stale; use `bank disk scans --volume Data` to inspect their scope and status.

`bank disk get <id-or-ref> --to <new-file>` retrieves one hashed ordinary file from an online copy. It verifies the full stored BLAKE3 digest before publishing the destination and tries another copy after a source read failure or digest mismatch. Existing destinations are never overwritten, including files created concurrently. If no copy is usable, the error names known offline volumes to connect. Directories, archive members, links, cloud placeholders and files excluded by current content rules cannot be retrieved. A hashed archive can be retrieved as a whole file.

The destination directory must already exist. Retrieval stages a private copy beside the destination for atomic publication, independently of the configured `temp` directory. On Windows the destination must be on a different volume from the online source copies. Only Windows currently discovers mounted catalogue volumes. The server never knows which disks are attached: each command matches the known volumes' fingerprints against this machine's mounts, which is where `online` and the mounted paths in its output come from. `--json` returns the full verified digest, destination and selected source. Cancellation or verification failure removes the temporary copy without publishing a partial destination.

A scan lists directories, hashes unknown files, lists archives, extracts document text and reads embedded metadata. It skips links, cloud placeholders, excluded paths and name-only files. ZIP, 7z, RAR and tar listings can include nested archives. Documents include plain text, Markdown, CSV, HTML, Office, OpenDocument and PDFs with a text layer. Source code and configuration files keep their names only. Extracted document text is capped at 4 MB and stored as `truncated` beyond that. A document whose bytes bank already holds as a message attachment or library file, and has text for, is not read again, and bank does not read again what a scan read.

Archive listings and in-process document extraction read a held source file. Windows refuses writers until the read ends. Its size, modified time, change time and file ID must match the catalogue entry. A change time that changes during a move also requires rehashing. FAT and exFAT record no change time, so on those disks the scan hashes the held file again before reading it. A file that changed since hashing, or that another program has open for writing, is skipped as `changed` and retried by the next scan. New hashes record that their bytes came from a held object matching the listed timestamps and file ID. Listing a ZIP or 7z then reads its index, so a large archive costs little beyond its hash on NTFS.

Older catalogue hashes lack this provenance. Pending archive and document extraction verifies those files in full through the held handle, even on NTFS and ReFS. Matching timestamps alone never promote an older hash. This adds a full read whenever an older file needs direct extraction, without a temporary copy or a catalogue-wide rehash. The upgrade preserves historical hashes and cached results.

External tools receive verified temporary copies because reopening a source path can follow an ancestor redirected through a junction. One ExifTool process serves the whole metadata phase and receives one file at a time. Each metadata file, including a video, needs a full verified copy. PDF parser failures also need a verified copy before the `pdftotext` fallback runs.

On volumes with stable file IDs, matching hard links can reuse a hash within the scanned subtree. Scan a common parent of the links to repair conflicting hashes left by older scans.

A changed or unavailable device serial requires an identity decision when the volume resembles a known one. Rerun with `--volume <id>` to confirm the known disk, or `--new-volume` to record a separate disk. This can also happen after moving a disk to another enclosure.

Ctrl+C keeps committed work. Run the same command again to continue. The summary includes phase times and the log path under `%LOCALAPPDATA%\attic\logs`. Use `--log-level debug` to log individual reads.

## Set aside duplicate copies

Name the folders whose copies stay, then review what would move:

```powershell
bank disk dedupe plan --keep E:\Files --keep F:\Photos
bank disk dedupe apply --keep E:\Files --keep F:\Photos
```

`plan` lists hashed contents that have a copy inside the kept folders and copies outside them, most bytes outside first. It skips contents under `--min-size` (default `1M`) and stops after `--limit` contents (default 100). `apply` hashes the kept copy and each extra copy again, and moves an extra copy only when both still match the catalogue. It moves the copy into `.attic-quarantine\<run>\<original path>` on the same disk and never deletes anything, so a move is a rename and a copy can go back to its original path by hand. Scans skip the quarantine folder. `bank disk entry <id>` reports a moved copy and the kept entry, and the next scan of its folder marks it missing. A copy put back by hand takes part again once a scan of its folder finds it.

Only hashed files take part, so scan with hashing first. Emptying the quarantine is up to you; delete a quarantined copy only once its kept copy is backed up somewhere else.

## Organize files with a reviewed plan

A person or agent decides where things go; `bank disk organize` only carries out the reviewed moves. Write a move list whose paths are relative to `root`:

```json
{
  "root": "E:\\",
  "moves": [
    {
      "from": "Inbox/award-2014.pdf",
      "to": "Documents/School/award-2014.pdf",
      "reason": "school award"
    },
    { "from": "Downloads/Robot", "to": "Projects/Robot", "reason": "whole project folder" }
  ]
}
```

```powershell
bank disk organize prepare moves.json
bank disk organize apply moves.plan.json
bank disk organize undo moves.plan.json
```

`prepare` reads every source without changing it and saves `moves.plan.json` with a baseline of each move: every file and folder inside it, including empty folders, and each file's ID, size, modified and change times and BLAKE3 digest. Sources are recorded under the names the disk stores, so undo restores the exact spelling. It refuses paths outside `root`, moves whose sources or destinations overlap, existing destinations, links, junctions, cloud placeholders and hard links split across moves. A source that cannot be read in full blocks the plan, and nothing is saved until every move is ready. It never replaces an existing file and never saves the plan inside a move, so delete an earlier plan before preparing again; a name whose journal records a run stays taken. It also lists the folders the destinations would create, so new structure is reviewed apart from moves into existing folders. A move is a rename on one volume, so it never copies, replaces or deletes anything.

`apply` checks every move before it renames anything, including moves an earlier run finished. A written, changed, added or missing file, or a destination that is now taken, blocks the run with the move and the reason. Only one `apply` or `undo` runs on a plan at a time. Each move is journalled in `moves.plan.json.journal.jsonl` before its rename and again once its destination holds exactly the baseline. A move that arrives different goes back. Run `apply` again after an interruption: finished moves stay, and an interrupted one counts as done or not done only when one place holds exactly the baseline and the other is empty. Anything else is reported for a decision by hand.

On NTFS and ReFS a rename keeps the file record, so the same file ID also keeps the file's streams, times, attributes, owner and permissions. An unchanged change time shows that none of them, and none of the bytes, was rewritten since `prepare`, even when a program put the modified time back. The rename itself updates the moved object's own change time, so the journal records the new one after each verified move. FAT and exFAT give a moved file a new ID and keep no change time, so there every apply and undo rereads the bytes against the digests.

`undo` moves every applied move back, last first, when it still matches the baseline and its original path is free. Changed moves stay where they are and are reported; the others still go back. Folders that the moves created are removed once they are empty again, also by a later `undo` once the last blocked move is back.

The catalogue is not changed. Scan `root` afterwards; on NTFS and ReFS the entries keep their identity across the moves. Organizing never reaches bank serve, and identifying the disk needs Windows.

## Verify stored file hashes during maintenance

`verify` runs only when explicitly invoked. Normal scans and file changes do not trigger this maintenance pass. Run it when the source disk is mounted and can be read for the duration of the check.

```powershell
bank disk verify --under E:\Files
bank disk verify --volume Data --under /Files --json
```

Verification rereads each selected catalogue file and compares its full BLAKE3 digest, even when its size and timestamps have not changed. It checks that specific copy, including copies marked missing, without falling back to another disk. It leaves source bytes, catalogue hashes and extracted results unchanged. A mismatch means the bytes differ from the baseline; it does not establish corruption.

`--under` is required. Mounted paths use the disk's current identity. `--volume` confirms an ambiguous identity and also accepts volume-relative paths, including missing folders or offline volumes. Links, junctions and cloud placeholders are not read. Like scanning, mounted volume identification currently requires Windows.

Results distinguish matched, mismatched, unreadable, missing, unavailable and unknown files. Unknown means the catalogue has no full digest, or the scope contains no catalogue files. Verification does not discover files absent from the catalogue. Any result other than matched exits with code 1. The text output ends with counts; `--json` streams one JSON entry per line followed by a summary with `type: "summary"`. The summary's `complete` flag means selection finished, not that all files matched. Cancellation or a catalogue error leaves a partial report with `complete: false` and a nonzero exit.

Ordinary scans can reuse a hash when file metadata is unchanged. `verify` checks those bytes explicitly. `scan --rebuild-content` rebuilds archive listings and document text; it does not replace verification of every selected file.

To keep a dated report, use PowerShell 7.4 or later, which [preserves native output bytes during redirection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection#redirecting-output-from-native-commands). Run this from a reports folder outside the verified subtree:

```powershell
$report = "disk-verify-$(Get-Date -Format yyyyMMdd-HHmmss).ndjson"
bank disk verify --volume Data --under /Files --json > $report
$verifyExitCode = $LASTEXITCODE
Get-Content -LiteralPath $report -Tail 1
"Verification exit code: $verifyExitCode"
```

Exit code 0 means every selected file matched its stored digest. Keep reports to see which scope was checked and which files differed or could not be checked. A successful report describes the bytes read during that run; it does not establish that they remain unchanged afterwards. Verification does not store a last-checked status in the catalogue.

For recurring maintenance, Windows Task Scheduler can run the same command at the chosen interval while the disk is connected. Give each run a separate report and retain the command's exit code. bank does not install a schedule or start a background verifier.

## Rebuild archive listings and document text

Older scans could attach results to the wrong content if a file changed between hashing and extraction. Ordinary rescans reuse those results. To rebuild the archive listings and document text associated with present files below a selected folder, run:

```powershell
bank disk scan E:\Files --rebuild-content
```

Results belong to content, so rebuilding also updates what other copies of those bytes show. Metadata and enrichment results are kept. The command cannot be combined with `--no-hash`.

## OCR and image descriptions

Scanning never runs AI. Select already-hashed files on an online volume, then run enrichment explicitly:

```powershell
bank disk enrich --task ocr --under E:\Scans --limit 20
bank disk enrich 36331 36332 --task describe --provider openai --model YOUR_VISION_MODEL
bank disk analysis 36331 --json
```

OCR defaults to local Tesseract. It reads images and PDFs marked `needs_ocr`, with the configured languages and page limit. Descriptions default to an OpenAI-compatible endpoint at `http://localhost:11434/v1`. OpenAI-compatible and Codex tasks require an explicit vision model. Remote endpoints receive image bytes and the prompt, require HTTPS, and refuse redirects. Set `ai.api_key_env` to an environment variable's name when authentication is needed. HTTP is accepted for localhost and loopback addresses.

An authenticated native Codex CLI is also available through `--provider codex --model MODEL`. It runs each image in an ephemeral session with tools disabled and a restricted permission profile. Strict configuration rejects unsupported settings; the profile was verified with Codex 0.162.1. On Windows, `ai.codex` must point to `codex.exe`, rather than a `.cmd` or `.bat` shim. Codex is limited to 20 contents per command.

Vision providers accept PNG, JPEG, GIF and WebP up to 20 MiB. Tesseract also accepts TIFF and BMP. Tools receive verified temporary copies. Results retain their task, provider, endpoint, model and extraction policy. Duplicates reuse successful results. `--force` repeats completed work and preserves the previous answer if the new attempt fails. Provider outages stop the run without recording per-content failures. `bank disk analysis` compares results; search includes their text offline.

The run reaches the catalogue through bank serve. It pages through the selected files, then leases each content's work under its policy before reading it, and renews the lease every 30 seconds while the provider runs. A lease runs out two minutes after its last renewal, so the work of a worker that crashed or lost its connection can be claimed by the next run. Saving a result ends the lease, and only the current lease saves: a result that arrives after its lease ran out and went to another worker is refused and changes nothing, and the run reports it as not saved.

## Scheduled scans

A scan rehashes only what changed, so one nightly run keeps the catalogue current. The first scan of a disk hashes every file and can take hours; later runs take seconds to minutes.

### Windows

The scans write through `bank serve`, so set `BANK_URL` and a write `BANK_TOKEN` as user variables first ([Setup](#setup)); a task started as you sees them. Save this as `%LOCALAPPDATA%\attic\scan-nightly.ps1` and edit the two lists:

```powershell
$folders = @("$env:USERPROFILE\Documents")   # folders on internal drives, scanned every night
$disks = @('Data')                           # external disks by label, scanned when attached

foreach ($folder in $folders) { bank disk scan $folder }
foreach ($drive in Get-CimInstance Win32_LogicalDisk) {
    if ($drive.VolumeName -in $disks) { bank disk scan "$($drive.DeviceID)\" }
}
```

A scan unpacks nested archives to `temp`, which must be on another disk than the one it scans; see [Configuration](#configuration). The default system temporary directory is on `C:`, so folders there need `temp` set to an existing directory on a disk that stays attached and is not in `$disks`, such as a second internal drive. Every scan reads the same `config.toml`, so a `temp` on one of the listed disks makes that disk's scans fail. When the only other disk is one of `$disks`, give the folder scans their own copy of the configuration with `temp` on that disk and pass it as `bank disk scan $folder --config <file>`. The disk scans keep the default on `C:`, and the folder scans then need that disk attached.

List external disks by label rather than scanning every attached volume: once a folder on `C:` has been scanned, `C:` is a known volume too, and scanning its root would index the whole system drive. The label is the drive's name in Explorer. A disk whose USB bridge reports no serial cannot be scanned unattended: a sector clone on such a bridge looks the same, so every scan of it stops on the identity question and the loop moves on. Scan it by hand with `--volume <id>` once you have checked which disk it is.

Register the script as a nightly task:

```powershell
$action = New-ScheduledTaskAction -Execute powershell.exe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:LOCALAPPDATA\attic\scan-nightly.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit 0 `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'bank nightly disk scan' -TaskPath '\aqt\' -Action $action `
    -Trigger $trigger -Settings $settings
```

The task uses Windows PowerShell, which every Windows install has, and `-ExecutionPolicy Bypass` lets it run the script under the default `Restricted` policy. It runs while you are signed in, and `-StartWhenAvailable` catches up after a night the PC was off. bank serve must be reachable and run the commit this `bank` was built from. Each scan writes a log to `%LOCALAPPDATA%\attic\logs`, and bank serve's `GET /v1/disk/scans` lists the runs. A scan cut off by sleep or a lost connection is recorded as interrupted five minutes later, and the next night's run continues it. `Start-ScheduledTask -TaskPath '\aqt\' -TaskName 'bank nightly disk scan'` runs it once now.

### macOS

`bank disk scan` works on Windows only for now: identifying a disk uses Windows volume APIs. On macOS the same loop would run from a launchd job once that support exists.

## Configuration

Use `%APPDATA%\attic\config.toml`, or select another file with `--config`. `bank disk config` prints the effective settings and rules. The file, the scan logs under `%LOCALAPPDATA%\attic\logs`, the `.attic.toml` folder files and the `.attic-quarantine` folders keep the name the catalogue had when it was a separate program, so existing disks and settings keep working.

`temp` selects one existing directory for nested archives and verified metadata, PDF fallback and enrichment copies. It defaults to the system temporary directory and must be on another disk when scanning. To scan C:, set `temp = 'D:\AtticTemp'` to an existing directory on another disk. Scans keep parent and child nested archives there together while listing them. Allow the sum of their sizes across active nesting levels, up to `unpack_max_bytes` per level below the outer archive. An `unpack_max_bytes` value of zero leaves this space unbounded. External tools also need space for one full input copy at a time. Private `aqt-attic/scan-*` workspaces are removed after use; abandoned workspaces are cleaned after a day when their locks are free.

Legacy `archives.temp`, `metadata.temp` and `ai.temp` settings remain accepted. Empty `metadata.temp` and `ai.temp` values inherit the shared directory. Conflicting explicit directories are rejected. Remove the legacy settings when choosing a different top-level `temp`.

Patterns use gitignore syntax and ignore case. Defaults exclude dependency and build output, game libraries and Windows system paths. BitLocker recovery-key files keep their names only. Configured patterns follow the defaults, so `!pattern` can re-include a path. A slash anchors a pattern at the volume root; use `**/name/` for any depth. On Windows, match a literal `[` with `[[]`.

The following example shows the defaults, plus optional exclusions for one volume. Byte limits accept zero for no limit.

```toml
temp = ""
exclude = []
name_only = []
hash_max_bytes = 0

[archives]
depth = 2
unpack_max_bytes = 4294967296

[text]
max_bytes = 67108864
pdftotext = "pdftotext"

[metadata]
enabled = true
exiftool = "exiftool"
max_bytes = 0

[ai]
provider = ""
endpoint = "http://localhost:11434/v1"
model = ""
api_key_env = ""
max_bytes = 67108864
timeout_seconds = 300
max_tokens = 4096
token_parameter = "max_tokens"
ocr_lang = "eng"
ocr_max_pages = 20
tesseract = "tesseract"
pdftoppm = "pdftoppm"
codex = "codex"

[[volume]]
label = "Data"
exclude = ["/Games/"]
```

`archives.depth = 0` disables archive listings. `unpack_max_bytes` limits each nested archive. `text.max_bytes` limits the source file size eligible for text extraction. `metadata.max_bytes` bounds the files given to ExifTool; it defaults to no limit, so large videos can need equally large temporary copies. `text.pdftotext` selects the Poppler binary; if unavailable, PDF parser failures remain failures. `ai.max_bytes` bounds a verified enrichment copy. `ai.token_parameter` also accepts `max_completion_tokens`. Install Tesseract language data for each language in `ocr_lang`, such as `deu+eng`.

### Configure a folder and its children

Place `.attic.toml` in a disk's root for rules that apply across that disk, or inside a folder for rules below it. Scans discover these files automatically. A scan started inside a subtree also reads the files in its ancestors, up to the volume root.

To keep hashes and metadata without listing archive contents, save this as `E:\Backups\.attic.toml`:

```toml
[archives]
depth = 0
```

ZIP, 7z, RAR and tar files below `E:\Backups` stay catalogued with their names, paths, sizes, dates and hashes. Hashing still reads each archive's bytes. The archive phase does not open these archives or list their members. Document text and embedded metadata extraction continue for their supported file types.

A deeper file can override the inherited depth. In `E:\Backups\Selected\.attic.toml`, set `depth = 1` under `[archives]` to list archives in that subtree without opening nested archives.

Inspect the settings before scanning with `bank disk config --under E:\Backups\Selected`. It lists the contributing folder files, effective archive depth and pattern sources. This command needs a mounted Windows volume and never reaches bank serve. Add `--volume <id>` when the main configuration selects rules by catalogue volume ID.

Folder files also accept `exclude` and `name_only`:

```toml
exclude = ["/Cache/"]
name_only = ["*.key"]

[archives]
depth = 0
```

Patterns are relative to the folder containing the file. `/Cache/` selects that folder's direct child; `**/Cache/` selects any depth. Folder rules follow the global and volume rules, from the volume root down. Later matching patterns win, including `!pattern`. An excluded directory is not visited, so a file inside it cannot re-include the directory.

`name_only` keeps filesystem details without hashing, text extraction or embedded metadata extraction. `archives.depth = 0` keeps those other operations enabled. Folder files accept only `exclude`, `name_only` and `archives.depth`; machine settings such as `temp`, tools and AI providers stay in the main configuration. Invalid, unreadable or oversized folder files stop the scan. The size limit is 64 KiB, and links and cloud placeholders are refused.

Folder files control scans. Existing catalogue results remain searchable, including archive members recorded before a rule changed or through another copy of the same content. Other commands continue to use the main configuration.

A deeper archive policy upgrades a shallower cached listing, including when identical copies have different folder policies. Failed upgrades keep the previous listing. Completed, verified upgrade attempts that encounter encryption, parser failures or unpack limits are remembered for that content, requested depth and effective unpack limit. Unchanged scans skip those attempts. Changing the depth or unpack limit can enable another upgrade attempt. Source read failures, missing multipart volumes and changed bytes remain retryable. To retry an initial listing at the same depth after changing its unpack limit, use `--rebuild-content`. Rebuilding also clears remembered upgrade failures for the selected content.

Folder policy lookup preserves directory spelling, so case-sensitive sibling folders can have separate settings. Patterns still ignore case.

`--rebuild-content` deletes selected archive listings and document text for all copies that share the content. Deletion includes content under depth-zero rules. Depth-zero copies are not relisted. To refresh older listings, set a positive archive depth for the selected copies before running `bank disk scan E:\Backups --rebuild-content`.

Unreadable directories leave catalogue history intact. Files below them receive no content processing while their folder policies are unresolved.

## Through bank serve

Every catalogue operation is below `/v1/disk` in bank's one OpenAPI document at `/openapi.json`: the reads (`/v1/disk/search`, `/v1/disk/contents/{ref}`, `/v1/disk/entries/{id}`, `/v1/disk/volumes`, `/v1/disk/scans`, `/v1/disk/redundancy` and so on), the paged listing that `verify` rereads, the copies `get` chooses from, the dedupe plan, and the writes: a scan's batches, a dedupe move and an enrichment lease and result. They take bank's tokens, and every operation that writes needs a write token. Failures are bank's tagged errors, such as `NotFound`, `AmbiguousRef` with its candidates, `ClaimLost` or `InvalidRequest`. Responses carry no `online` or `mounted_at`, and the server does not serve a file's bytes: to copy a file, run `bank disk get` on the machine with the disk.

`bank search` and `GET /v1/search` include the catalogue: a search without sender, source, account or date filters also returns files on disks, under `disks`, and `match` means the same for them as for messages. `/v1/disk/search` adds the filters only the catalogue has.

A scan through bank serve sends its work in batches of a few thousand entries or about 4 MiB, each applied and committed before the server answers, so a scan makes a few requests per batch rather than several per folder. Before it hashes, lists an archive, reads a document or asks ExifTool, it learns from the server which files still need that, so bytes another disk or bank already covered are not read again.

The server holds the volume while the scan runs: a second scan of the same volume answers `ScanRunning`. A batch whose answer was lost is sent again and applied once. Ctrl+C sends what is done and records the scan as interrupted. A scan that stops sending, because bank was killed or the connection is gone, is recorded as interrupted five minutes after its last request, and its volume is free again then. Stopping bank serve records its open scans as interrupted. Either way the next scan continues where it stopped.

Reconciling a folder can need to know whether a catalogued path still holds a file, which only the PC can see. The server then answers the batch with those paths instead of applying it, and the scan sends it again with the answers. An archive whose listing spans batches waits on the server, under `$BANK_DATA_DIR/scans`, until its last members arrive.

### Code mode through Executor

`executor/` is an [Executor](https://executor.sh) app that turns bank serve's live `/openapi.json` into typed tools, so an agent writes code such as `await tools.bank.disk.searchDisks({ q: "minecraft server" })` instead of calling one tool per endpoint. The document covers the whole archive, so the app offers bank's other operations too. It needs a local or self-hosted Executor: Executor Cloud cannot reach a tailnet or loopback address. The token travels only to the host in `executor/provider.ts`, and every operation that writes asks for approval.

```sh
bank token new executor --read-only                 # where bank serve runs
executor apps create --name bank --files apps/bank/executor
executor apps deploy --app <app-id> --files apps/bank/executor
```

Then connect the app's bank account in the Executor dashboard and paste the token there. The app reaches bank serve at `origin` in `executor/provider.ts`, `http://127.0.0.1:8480` for an Executor on the same machine. For a self-hosted Executor elsewhere, set `origin` to bank serve's tailnet address before deploying, and start that Executor with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, because it refuses private addresses otherwise. `mise run bank:ts` type-checks and lints it; the `apps` version in `package.json` must match `executor apps framework`.

## Design

### A place and its content have different identities

An entry identifies a filesystem object at a place on one volume. A content row identifies bytes by their full BLAKE3 digest. Multiple entries can point to one content row, and so can bank's message attachments and library files with the same bytes. Public content refs are `content:` and the first eight digest bytes in hex, so refs identify content rather than paths.

Volume fingerprints combine the filesystem and volume serial with available partition and hardware identifiers. A sector clone can share filesystem and partition identity. Automatic resolution requires enough hardware identity to avoid silently merging it into the original catalogue. Missing or conflicting device serials require `--volume` or `--new-volume`; enclosure changes can require the same decision.

On NTFS and ReFS, stable file IDs let an entry retain its identity across moves. FAT and exFAT use the parent and lossless filename identity because their synthesized file IDs can change when directory entries move. Display and search names are valid Unicode; filename identity preserves bytes that Unicode cleaning would otherwise merge.

Hard links identify one filesystem object through several paths. Entries retain their separate places, while stable object identity and matching size and timestamps allow hash reuse within the scanned subtree. Size or timestamp changes invalidate known content. A move that changes the change time requires rehashing because a rewrite followed by a rename can have the same size and modified time. A scan covering conflicting hard links rechecks their bytes.

### Versions keep earlier content searchable

The catalogue is a permanent history, so a file whose bytes change keeps what was read from its earlier content. `entry_versions` records each content an entry held, with its size and modified time, the scan that first saw it and the scan that saw it replaced. The earlier bytes are not kept, and nothing is deleted. Entries catalogued before version history start with one version whose first scan is the entry's last update, which can be later than the scan that hashed it.

A listing that resets an entry's content closes its open version. Hashing opens a version for the new content. When the latest version holds the same bytes, hashing reopens that version, so a touch, a save-via-rename or a hard-link check that rehashes unchanged bytes keeps one version. Moves and renames that rehash unchanged bytes reopen the same version. A missing entry keeps its open version, because missing is recorded on the entry.

Every content an entry holds has an open version, so content searches reach current and earlier contents through one `EXISTS` over the versions. Postgres plans that as a semi join. An `OR` of an entry `EXISTS` and a version `EXISTS` became hashed subplans that read the whole version table. `--current` keeps the original entry-only `EXISTS`. Place lists derive the flag from the entry: current while it points at the content, previous otherwise.

### Ancestry determines what moves or disappears

Every entry records its parent and its volume-relative path. The path is also indexed because filename and path words contribute to search ranking. Moving a directory updates descendants by parent ancestry. Path-prefix matching alone cannot distinguish directories during backup rotations or swaps.

Only a complete directory listing can mark an unseen entry missing. Unreadable and excluded directories leave their recorded descendants untouched. When a directory becomes a file or link, its descendants become missing. Rows remain available as history. Finishing a scan counts its remaining missing entries because an entry marked missing early can reappear elsewhere later in the scan.

### Verification preserves the catalogue baseline

`verify --under` is an explicit maintenance command, independent of scans and file changes. It streams selected entries from one catalogue query and rereads ordinary files against their full stored digests. Missing and unhashed entries remain in the selection. Each path is checked separately, including hard links and duplicate contents. The command does not update hashes or derived results. A mismatch only establishes that the bytes read differ from the baseline.

Verification requires an explicit subtree and resolves its mounted volume without updating volume identity. Ambiguous identity requires `--volume`. File opens refuse links and placeholders, including ancestor links. Results stream as files finish; cancellation keeps emitted results and marks the summary incomplete.

During a maintenance run, Windows rechecks the mounted fingerprint before each file so a removed or replaced disk is not treated as the selected copy. This adds work for small files but keeps the identity check on every read. Reports can be retained outside the catalogue; the catalogue keeps no verification status and bank runs no verifier on a schedule.

### Derived results describe the hashed bytes

Archive listings, document text and metadata belong to content. Once a result exists, copies on other disks reuse it. Document text is the one table bank's extraction writes too, so a document read by either is not read again by the other. This makes attaching a result to the wrong digest a persistent catalogue error.

The scanner reads archives and documents through a held source object. It opens the file sharing it for reading only, so Windows refuses any writer until the read ends. It extracts only when the file's size, modified time, change time and file ID still match the catalogue entry. New hashing reads through a held object matching the listed stamp, and the catalogue update requires that same stamp. The entry's `hash_trusted` flag records this provenance. Listings preserve the flag only while they retain the stamp and digest. Hard-link reuse requires a trusted sibling with the same object ID and stamp. Ordinary NTFS and ReFS writes update change time. Scans trust these timestamps and do not detect software that explicitly restores them. FAT and exFAT have no change time, so a same-size replacement with a preserved modified time would pass the check there; on those file systems the scanner hashes the held file again and compares the digest before extracting. The verified outer archive handle stays open for the listing lifetime. Parser reopens use independent read offsets on that handle, so FAT and exFAT do not repeat verification for each open.

Pending direct extraction verifies an untrusted digest through the held handle, even on NTFS and ReFS. Verification leaves its historical digest and provenance unchanged. Matching current timestamps or updating a listing never establishes provenance. Existing caches remain intact.

Earlier versions copied each archive to scratch and verified the copy's BLAKE3 digest first. A 50 GB archive cost a second full read and a 50 GB write to list a few megabytes of index. `verify` remains the way to reread files against their digests.

External readers, ExifTool and pdftotext, receive digest-verified temporary copies read through held source objects. Holding the source file does not prevent an ancestor from being redirected through a junction before an external tool reopens its path. In-process extraction reads the held object and its size directly. A PDF gets a copy only if the in-process parser fails and `pdftotext` is enabled.

ExifTool runs in `-stay_open` mode for the whole metadata phase and receives one verified copy per request. Each source stays locked only until its copy is verified, and each copy is removed after its request. A timeout, a broken answer or a crashed process ends that ExifTool, and the next file starts a fresh one. Changed files, files open for writing elsewhere, failed reads and size limits leave work eligible for a later scan. A repeatable parser failure can be stored as a result of the content.

`scan --rebuild-content` discards archive listings and document text selected through present files below the scan root. It repairs results produced before scans checked the bytes they read. The reset affects all copies sharing that content, and keeps metadata, enrichment results and text written by hand. Current folder policies determine which results are regenerated. Depth-zero copies do not regenerate archive listings.

Nested archives and verified tool copies use private `aqt-attic/scan-*` workspaces under the configured `temp` directory. Windows checks that scratch is off the source volume. File locks distinguish abandoned workspaces from active readers. Cleanup failures leave files available for a later cleanup attempt.

Archive members carry names, paths, sizes, timestamps and CRC32 where available. They are not independently hashed. A nested archive adds another `::` path component. Depth and unpack limits bound traversal. Multipart RAR listings need their sibling volumes; a missing part remains retryable. Archive listings commit as a unit so interruption cannot preserve a partial transaction.

Folder policies retain filesystem directory spelling. The archive queue resolves the sparse policies into disjoint byte-order path ranges once per phase. Each range selects entries through `entries_path_idx`, including nested overrides without comparing every archive with every policy.

An incomplete depth upgrade keeps the successful listing and its depth. Completed, verified upgrade attempts that encounter encryption, parser failures or unpack limits record the content, exact requested depth and effective unpack limit. Changing the depth or unpack limit can enable another upgrade attempt. Source I/O, changed digests and multipart probes remain retryable. Initial listings remain cached at their recorded depth. Retrying an initial listing at the same depth requires rebuilding selected content, even if the unpack limit changes. Rebuilding deletes remembered failures with the selected archive cache.

Document extraction keeps at most 4 MB of text per content, the same cap bank uses; longer text is stored as `truncated`. PDFs without a text layer become `needs_ocr`. Source code, configuration and logs keep their names without text extraction. ExifTool handles embedded metadata separately from document text.

### Scans and enrichment have separate lifecycles

A volume-scoped advisory lock prevents scans of one volume from interleaving identity decisions. Directory and hash work commits periodically so searches see progress and interruption keeps completed work. Hashing follows path order to avoid unnecessary seeking on USB hard disks. Metadata extraction keeps one ExifTool process for the phase and reads one verified copy per request. Catalogue pages and commits stay bounded independently of the tool lifecycle.

Enrichment is an explicit command. Its provider interface exposes the task, model, extraction policy, supported extensions and one-file reader. Tesseract performs local OCR. OpenAI-compatible HTTP sends inline images. Optional Codex CLI execution uses restricted ephemeral sessions.

Enrichment results retain content, task, provider, endpoint, model and policy identity. Language, page limits and output limits affect the policy. A lease on each content and policy prevents duplicate concurrent calls without holding a database connection across a provider call that can take minutes; an advisory lock held that long would also tie the lock to one connection the API cannot keep. Each completed result commits independently. New work precedes failed retries; provider-wide outages stop the selection. A failed forced attempt preserves a prior successful result.

### A scan writes through a session

The disks attach to a PC and the database lives on a server that publishes Postgres on loopback only, so a scan writes through `bank serve`, like every `bank disk` command. On a machine without `BANK_URL` the same requests go to the API served in process. The scan driver is written once against an interface holding what it needs from the catalogue. The client queues its calls and sends them as numbered batches, which the server replays against `store.Scan` in order, so reconciliation runs on the server. The tests also scan straight into `store.Scan` and compare.

A batch's entry changes commit in the scan's transaction when the batch ends. Contents, texts, metadata and archive listings keep their own short transactions, as in process, so concurrent scans of different disks still take content locks in one order and never hold them across a request. A batch number applied already is answered from the session without being applied again, which makes resending after a lost answer harmless, and a failed batch ends the scan as failed, as an error ends a scan in process.

Some calls would answer the driver at once if it held the database. Through the API the answer is decided without waiting: a listing's subfolders are numbered by the client; a hard link's digest is reused when its page or this scan's own earlier work says a trusted link holds it; an archive is listed when its page said its content needs it, and the client asks again only for a content it listed already in this scan. Whether a catalogued path still holds a file needs the disk, and the server must not wait on the client inside a transaction, so a batch that asks is rolled back with its questions and applied when it comes back with answers. The client answers as a scan in process does, yes when it cannot tell.

The session holds the volume's advisory lock between batches. A session idle for five minutes, or still open when the server stops, finishes as interrupted, which is what a killed scan becomes when the next scan of its volume starts.

### Search groups preserve their own ranking

Filename, archive-member, document-text, metadata and enrichment indexes rank separately because their BM25 scores are not comparable. Content results include earlier versions unless `--current` is set; filename results describe entries as they are now. Every searchable word must match within one result unless `--any` is set. Query pieces with no searchable terms must not turn an otherwise valid every-word query into an empty match.

Entry extensions describe files; archive-member extensions describe members. Volume and folder filters identify where the enclosing file lives. An archive named by `--under` includes its members. Copy lists retain the same filters as the search result.

Volume, kind and extension are entry BM25 fields, so ParadeDB can apply those filters inside the index scan. Subtree filters use the entry path range. Ranked entries and archive members break equal scores by ID. Wordless searches retain path order. The ranked entry page is selected before joining volumes and contents, so ParadeDB can stop after the requested page instead of returning every match for Postgres to sort.

### The CLI and the API return one shape

`internal/attic/view` turns catalogue records into what readers receive: every place says how to open it and, on the machine the disks attach to, whether its disk is attached now. bank serve's `/v1/disk` routes return those types without mounts, and `bank disk` spells them again for the mounts of the machine it runs on before `--json` prints them, so a field added for one reader reaches the other. The server is not that machine: `online` and `mounted_at` are left out of its answers and hidden from the document, rather than always false. Errors differ on purpose: the API gives each failure a `_tag` and its own schema so agent code can branch on it, while the CLI prints the message.

### Dedupe sets copies aside and never deletes

A copy leaves its place only when a copy inside the kept folders and the copy itself both hash to the catalogued digest at that moment, so a file that changed since its scan is never treated as a duplicate. The move is a rename into `.attic-quarantine` on the same disk that never replaces a file: it frees no space yet, and it cannot lose bytes. After the move, dedupe opens the quarantined file again without following links and requires the hashed bytes, unwritten since: the same file, or a second hash where FAT and exFAT gave the moved file a new ID. Anything else goes back. Before each move, the kept copy and both disks must still be the ones checked at the start. Deleting stays a person's decision, for once the kept copy is backed up off-site. Each move is recorded against the entry through bank serve before the command reports success; a move that cannot be recorded is undone, unless the original path was taken meanwhile, and then the error names where the copy stayed.

### Organize renames only what the plan recorded

Choosing destinations stays outside bank, so a person or agent supplies the moves. A prepared plan is the reviewed selection: one root on one volume, paths that neither equal nor contain one another, and a baseline of every file and folder each move covers. Because no two places nest, the moves do not depend on their order, and undo can restore some while refusing others.

Moves stay on one volume and are renames that refuse an occupied destination. On NTFS and ReFS the rename keeps the file record, so comparing file IDs, sizes, modified times and change times covers alternate streams, security descriptors, timestamps and in-place edits without snapshotting each one. The rename updates the moved object's own change time, so the journal records the time each verified rename leaves, and only while a rename is unsettled is a single moved file compared by its bytes. Hard links split across moves are refused, because renaming one link would change the time the other move recorded. Folder times are not compared: they move whenever a program adds and removes a scratch file inside, and the tree comparison already covers what a folder holds. FAT and exFAT IDs follow directory entries and they keep no change time, so objects there are compared by their bytes in every check. Folders are checked as trees: each baseline item must appear exactly once, and nothing may be added.

The journal sits beside the plan, is locked for the whole run and is appended and synced before and after each rename. Replaying it gives each move's last state, but the files on disk decide where an object is: when only one place is taken, that place must hold exactly the baseline, and when both are, only a settled journal entry can choose. A torn last line was never durable and is cut off. A file without one complete line could be anything, so it is refused rather than cut. Preparing never replaces a file and refuses a name whose journal records a run or is held by one, and a run reads its plan again under the journal's lock, so a journal always describes its plan.

These checks guard against ordinary use of the disk during a run: editors and sync clients writing files, folders made or removed, another organize run. Paths are resolved again by each call, so a program that swaps a path between two calls on purpose can still redirect one; it runs as the same user and could change the files directly, so organize does not try to outrace it. Organize leaves the catalogue alone; on stable-ID volumes the next scan follows the renames as moves.
