# attic

Search backup disks and USB sticks even when they are unplugged. Attic stores file metadata, BLAKE3 hashes, archive listings and document text in ParadeDB. It does not change source files. Scanning runs on Windows; search runs wherever the database is reachable.

## Setup

```sh
docker compose up -d --wait
go build -o "$USERPROFILE/.local/bin/attic.exe" ./cmd/attic
```

`DATABASE_URL` defaults to `postgres://attic:attic@localhost:5436/attic?sslmode=disable`. Database migrations run on startup.

The identity upgrade rewrites catalogue entries once and builds indexes. Startup waits for it to finish, and PostgreSQL needs additional database storage during the upgrade.

Install ExifTool for embedded metadata. OCR also needs Tesseract and Poppler's `pdftoppm`. Missing ExifTool leaves metadata pending and records `metadata_unavailable`; the rest of the scan continues.

## Use

```powershell
attic scan E:\
attic scan E:\Files --no-hash
attic search minecraft server
attic search werkstudent --ext pdf
attic search notes --under E:\Files --json
attic search --under E:\Backups\Minecraft.7z
attic show 36331
attic text 36331
attic metadata 36331
attic volumes
attic scans --volume Data
attic dupes --same-volume
attic skips --reason unreadable
attic stats
attic help scan
```

Search requires every searchable word by default; `--any` accepts any word. Words can match names, paths or name fragments. Archive members, document text, metadata and enrichment results appear in separate ranked groups. `--volume` accepts a label or ID. `--under` accepts a mounted path, or a volume-relative path with `--volume`. All read commands support `--json`.

Argument parsing errors exit with code 2. Command failures, including `enrich --task ocr` without targets or `--under`, exit with code 1.

An entry ID identifies a file at a place. A content ref such as `attic:3f9a1c2b4d5e6f70` identifies its bytes across disks. `show <ref>` lists the copies. Missing files remain searchable and are marked missing. `dupes --same-volume` counts copies that share a disk.

A scan lists directories, hashes unknown files, lists archives, extracts document text and reads embedded metadata. It skips links, cloud placeholders, excluded paths and name-only files. ZIP, 7z, RAR and tar listings can include nested archives. Documents include plain text, Markdown, CSV, HTML, Office, OpenDocument and PDFs with a text layer. Source code and configuration files keep their names only. Extracted document text is capped at 1 MB.

On volumes with stable file IDs, matching hard links can reuse a hash within the scanned subtree. Scan a common parent of the links to repair conflicting hashes left by older scans.

A changed or unavailable device serial requires an identity decision when the volume resembles a known one. Rerun with `--volume <id>` to confirm the known disk, or `--new-volume` to record a separate disk. This can also happen after moving a disk to another enclosure.

Ctrl+C keeps committed work. Run the same command again to continue. The summary includes phase times and the log path under `%LOCALAPPDATA%\attic\logs`. Use `--log-level debug` to log individual reads.

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
