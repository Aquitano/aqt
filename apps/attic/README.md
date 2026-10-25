# attic

Search backup disks and USB sticks even when they are unplugged. Attic stores file metadata, BLAKE3 hashes, archive listings and document text in ParadeDB. It does not change source files. Scanning runs on Windows; search runs wherever the database is reachable.

## Setup

```sh
docker compose up -d --wait
go build -o "$USERPROFILE/.local/bin/attic.exe" ./cmd/attic
```

`DATABASE_URL` defaults to `postgres://attic:attic@localhost:5436/attic?sslmode=disable`. `attic scan`, `attic enrich` and `attic migrate` run database migrations on startup. The other commands only read: they open read-only sessions and stop with an error when the catalogue's schema version differs from the binary's. Run `attic migrate` after installing a new build.

The identity upgrade rewrites catalogue entries once and builds indexes. Migration waits for it to finish, and PostgreSQL needs additional database storage during the upgrade.

Install ExifTool for embedded metadata. OCR also needs Tesseract and Poppler's `pdftoppm`. Missing ExifTool leaves metadata pending and records `metadata_unavailable`; the rest of the scan continues.

## Use

```powershell
attic scan E:\
attic scan E:\Files --no-hash
attic search minecraft server
attic search werkstudent --ext pdf
attic search notes --under E:\Files --json
attic search minecraft lobby --current
attic search --under E:\Backups\Minecraft.7z
attic show 36331
attic get 36331 --to C:\Recovered\document.pdf --json
attic text 36331
attic metadata 36331
attic volumes
attic scans --volume Data
attic dupes --same-volume
attic coverage --volume Data --under /Files
attic coverage --volume Data --json --limit 50 --offset 0
attic skips --reason unreadable
attic stats
attic migrate
attic help scan
```

Search requires every searchable word by default; `--any` accepts any word. Words can match names, paths or name fragments. Archive members, document text, metadata and enrichment results appear in separate ranked groups. `--volume` accepts a label or ID. `--under` accepts a mounted path, or a volume-relative path with `--volume`. All read commands support `--json`.

Argument parsing errors exit with code 2. Command failures, including `enrich --task ocr` without targets or `--under`, exit with code 1.

An entry ID identifies a file at a place. A content ref such as `attic:3f9a1c2b4d5e6f70` identifies its bytes across disks. `show <ref>` lists the copies. Refs show 16 hex characters of the BLAKE3 digest; every `<id-or-ref>` command also accepts a longer prefix, up to all 64, with or without `attic:`. If two contents share a ref, the command fails and lists each with a longer ref that tells them apart. Missing files remain searchable and are marked missing. `dupes --same-volume` counts copies that share a disk.

When a file's bytes change, the catalogue keeps what it read from the earlier content: archive listings, document text, metadata and enrichment results. The earlier bytes themselves are not kept. Archive-member, document-text, metadata and enrichment searches include these earlier versions by default. Text output marks such a place `previous version` and counts the other earlier holders as `held before`. In `--json`, every place of a content hit has `version` set to `current` or `previous`. A previous place shows the entry's path as it is now, with the size, modified time and ref it had then. `--current` leaves out content that no file holds now. Name and path search matches entries as they are now. `show <id>` lists the entry's versions with the scans that first saw each one and saw it replaced. For files catalogued before version history, the first scan shown is the last scan that updated the entry, which can be later than the scan that first read its bytes. `show <ref>` lists the files that hold the content now, then those that held it before. Use `text <ref>` or `metadata <ref>` to read an earlier version's results. Moves, renames and rehashing unchanged bytes keep one version.

`coverage` selects present files in the requested scope and counts distinct volume IDs for their completed full content hashes across the entire catalogue. It reports content recorded on fewer than two volumes, with unique byte totals. Multiple paths and hard links on one volume count as one volume. Unknown and invalidated hashes appear separately, with path byte totals that cannot be deduplicated. Offline volumes count; entries marked missing do not. With no scope, it reports the whole catalogue.

Coverage totals include all selected content, independently of pagination. `--limit` and `--offset` page the undercovered content and unknown-file lists separately. Each content lists up to 100 locations and its total path count. Location dates identify the recorded update scan's start, not a fresh verification. This read-only report does not rehash files or verify backup health or physical disk independence. Scans can be partial or stale; use `attic scans --volume Data` to inspect their scope and status.

`get <id-or-ref> --to <new-file>` retrieves one hashed ordinary file from an online copy. It verifies the full stored BLAKE3 digest before publishing the destination and tries another copy after a source read failure or digest mismatch. Existing destinations are never overwritten, including files created concurrently. If no copy is usable, the error names known offline volumes to connect. Directories, archive members, links, cloud placeholders and files excluded by current content rules cannot be retrieved. A hashed archive can be retrieved as a whole file.

The destination directory must already exist. Retrieval stages a private copy beside the destination for atomic publication, independently of the configured `temp` directory. On Windows the destination must be on a different volume from the online source copies. Only Windows currently discovers mounted catalogue volumes. `--json` returns the full verified digest, destination and selected source. Cancellation or verification failure removes the temporary copy without publishing a partial destination.

A scan lists directories, hashes unknown files, lists archives, extracts document text and reads embedded metadata. It skips links, cloud placeholders, excluded paths and name-only files. ZIP, 7z, RAR and tar listings can include nested archives. Documents include plain text, Markdown, CSV, HTML, Office, OpenDocument and PDFs with a text layer. Source code and configuration files keep their names only. Extracted document text is capped at 1 MB.

On volumes with stable file IDs, matching hard links can reuse a hash within the scanned subtree. Scan a common parent of the links to repair conflicting hashes left by older scans.

A changed or unavailable device serial requires an identity decision when the volume resembles a known one. Rerun with `--volume <id>` to confirm the known disk, or `--new-volume` to record a separate disk. This can also happen after moving a disk to another enclosure.

Ctrl+C keeps committed work. Run the same command again to continue. The summary includes phase times and the log path under `%LOCALAPPDATA%\attic\logs`. Use `--log-level debug` to log individual reads.

## Verify stored file hashes during maintenance

`verify` runs only when explicitly invoked. Normal scans and file changes do not trigger this maintenance pass. Run it when the source disk is mounted and can be read for the duration of the check.

```powershell
attic verify --under E:\Files
attic verify --volume Data --under /Files --json
```

Verification rereads each selected catalogue file and compares its full BLAKE3 digest, even when its size and timestamps have not changed. It checks that specific copy, including copies marked missing, without falling back to another disk. It leaves source bytes, catalogue hashes and extracted results unchanged. A mismatch means the bytes differ from the baseline; it does not establish corruption.

`--under` is required. Mounted paths use the disk's current identity. `--volume` confirms an ambiguous identity and also accepts volume-relative paths, including missing folders or offline volumes. Links, junctions and cloud placeholders are not read. Like scanning, mounted volume identification currently requires Windows.

Results distinguish matched, mismatched, unreadable, missing, unavailable and unknown files. Unknown means the catalogue has no full digest, or the scope contains no catalogue files. Verification does not discover files absent from the catalogue. Any result other than matched exits with code 1. The text output ends with counts; `--json` streams one JSON entry per line followed by a summary with `type: "summary"`. The summary's `complete` flag means selection finished, not that all files matched. Cancellation or a catalogue error leaves a partial report with `complete: false` and a nonzero exit.

Ordinary scans can reuse a hash when file metadata is unchanged. `verify` checks those bytes explicitly. `scan --rebuild-content` rebuilds archive listings and document text; it does not replace verification of every selected file.

To keep a dated report, use PowerShell 7.4 or later, which [preserves native output bytes during redirection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection#redirecting-output-from-native-commands). Run this from a reports folder outside the verified subtree:

```powershell
$report = "attic-verify-$(Get-Date -Format yyyyMMdd-HHmmss).ndjson"
attic verify --volume Data --under /Files --json > $report
$verifyExitCode = $LASTEXITCODE
Get-Content -LiteralPath $report -Tail 1
"Verification exit code: $verifyExitCode"
```

Exit code 0 means every selected file matched its stored digest. Keep reports to see which scope was checked and which files differed or could not be checked. A successful report describes the bytes read during that run; it does not establish that they remain unchanged afterwards. Verification does not store a last-checked status in the catalogue.

For recurring maintenance, Windows Task Scheduler can run the same command at the chosen interval while the disk is connected. Give each run a separate report and retain the command's exit code. Attic does not install a schedule or start a background verifier.

## Rebuild archive listings and document text

Older scans could attach results to the wrong content if a file changed between hashing and extraction. Ordinary rescans reuse those results. To rebuild the archive listings and document text associated with present files below a selected folder, run:

```powershell
attic scan E:\Files --rebuild-content
```

Results belong to content, so rebuilding also updates what other copies of those bytes show. Metadata and enrichment results are kept. The command cannot be combined with `--no-hash`.

## OCR and image descriptions

Scanning never runs AI. Select already-hashed files on an online volume, then run enrichment explicitly:

```powershell
attic enrich --task ocr --under E:\Scans --limit 20
attic enrich 36331 36332 --task describe --provider openai --model YOUR_VISION_MODEL
attic analysis 36331 --json
```

OCR defaults to local Tesseract. It reads images and PDFs marked `needs_ocr`, with the configured languages and page limit. Descriptions default to an OpenAI-compatible endpoint at `http://localhost:11434/v1`. OpenAI-compatible and Codex tasks require an explicit vision model. Remote endpoints receive image bytes and the prompt, require HTTPS, and refuse redirects. Set `ai.api_key_env` to an environment variable's name when authentication is needed. HTTP is accepted for localhost and loopback addresses.

An authenticated native Codex CLI is also available through `--provider codex --model MODEL`. It runs each image in an ephemeral session with tools disabled and a restricted permission profile. Strict configuration rejects unsupported settings; the profile was verified with Codex 0.162.1. On Windows, `ai.codex` must point to `codex.exe`, rather than a `.cmd` or `.bat` shim. Codex is limited to 20 contents per command.

Vision providers accept PNG, JPEG, GIF and WebP up to 20 MiB. Tesseract also accepts TIFF and BMP. Tools receive verified temporary copies. Results retain their task, provider, endpoint, model and extraction policy. Duplicates reuse successful results. `--force` repeats completed work and preserves the previous answer if the new attempt fails. Provider outages stop the run without recording per-content failures. `analysis` compares results; `search` includes their text offline.

## Serve the catalogue to agents

`attic serve` answers the read commands over HTTP. Like them, it opens the catalogue read-only.

```powershell
attic token new executor
attic serve --listen 127.0.0.1:8490
```

`token new` prints the token once. Every `/v1` route needs it as `Authorization: Bearer <token>`. Tokens are kept as SHA-256 digests in `%APPDATA%\attic\tokens`; `attic token list` and `attic token revoke <name>` manage them, and a revocation applies to the next request. There is no TLS, so listen on localhost, or on a Tailscale address to reach the API from the tailnet. `ATTIC_LISTEN` also sets the address. A catalogue at another schema version stops `serve` from starting; run `attic migrate` or upgrade attic first.

`/openapi.json` describes every operation and needs no token. `openapi.json` in this directory is the committed copy; regenerate it with `go run ./cmd/attic openapi > openapi.json` after changing the API, because a test fails while it is stale. Responses have the same shapes as `--json`. An error is JSON with a `_tag` naming the failure (`Unauthorized`, `InvalidRequest`, `NotFound`, `AmbiguousRef`, `Unavailable` or `Internal`), a `message`, and a `recovery` with what to do where the caller can act. Each tag has its own schema, so code generated from the document can branch on it.

`GET /v1/contents/{ref}/file` streams a file from an attached disk and checks its BLAKE3 digest on the way. The last 64 KiB wait until the digest matches, so a copy that changed since its scan ends short of `Content-Length` instead of delivering wrong bytes. Without an attached copy the answer is `Unavailable`, with the disks to connect. Like `attic get`, downloads need Windows volume discovery.

### Code mode through Executor

`executor/` is an [Executor](https://executor.sh) app that turns the live `/openapi.json` into typed tools, so an agent writes code such as `await tools.attic.catalogue.search({ q: "minecraft server" })` instead of calling one tool per endpoint. It needs a local or self-hosted Executor: Executor Cloud cannot reach a tailnet or loopback address. The token travels only to the host in `executor/provider.ts`, and any future write operation asks for approval.

```powershell
attic token new executor
executor apps create --name attic --files apps/attic/executor
executor apps deploy --app <app-id> --files apps/attic/executor
```

Then connect the app's attic account in the Executor dashboard and paste the token there. The app reaches attic at `origin` in `executor/provider.ts`, `http://127.0.0.1:8490` for an Executor on the same PC. For a self-hosted Executor on another machine, such as the VPS, set `origin` to the PC's tailnet address before deploying, run `attic serve --listen <tailnet address>:8490`, and start that Executor with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, because it refuses private addresses otherwise. `mise run attic:ts` type-checks and lints it; the `apps` version in `package.json` must match `executor apps framework`.

## Configuration

Use `%APPDATA%\attic\config.toml`, or select another file with `--config`. `attic config` prints the effective settings and rules.

`temp` selects one existing directory for verified copies and nested archives. It defaults to the system temporary directory and must be on another disk when scanning. To scan C:, set `temp = 'D:\AtticTemp'` to an existing directory on another disk. Archive verification reads and copies each outer archive in full before listing it. Allow scratch space for that archive, open multipart volumes and nested archives. Private `aqt-attic/scan-*` workspaces are removed after use; abandoned workspaces are cleaned after a day when their locks are free.

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

[metadata]
enabled = true
exiftool = "exiftool"
max_bytes = 1073741824

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

`archives.depth = 0` disables archive listings. `unpack_max_bytes` limits each nested archive. `text.max_bytes` and `metadata.max_bytes` bound their source files. `ai.max_bytes` bounds a verified enrichment copy. `ai.token_parameter` also accepts `max_completion_tokens`. Install Tesseract language data for each language in `ocr_lang`, such as `deu+eng`.

## Develop

```sh
mise run attic:check
```

Checks cover vet, race tests and lint, plus Linux and Windows builds. Set `ATTIC_TEST_DATABASE_URL` to a superuser on disposable ParadeDB. Set `PGSCHEMA_TEST_DATABASE_URL` for the shared migration tests; both can name the same server. Tests create separate databases, drop successful fixtures and retain failures for inspection. CI requires ExifTool, Tesseract and Poppler. HTTP and Codex tests use local doubles and make no paid API calls.

[DESIGN.md](DESIGN.md) describes catalogue identity and extraction decisions.
