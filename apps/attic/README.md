# attic

Search the files on backup disks and USB sticks, including disks that are not plugged in. attic records every file's metadata and a BLAKE3 hash in ParadeDB and never writes to the disks it reads. See [DESIGN.md](DESIGN.md) for the identity model and the roadmap.

Scanning runs on Windows. Search works from any machine that can reach the database.

## Setup

```sh
docker compose up -d --wait        # ParadeDB on 127.0.0.1:5436, or: mise run attic:db
go build -o "$USERPROFILE/.local/bin/attic.exe" ./cmd/attic
```

`DATABASE_URL` defaults to `postgres://attic:attic@localhost:5436/attic?sslmode=disable`. Migrations run on start through tern. Existing databases keep their `schema_migrations` history and adopt `schema_version` after validating that history. Unknown or missing migration entries stop startup before any schema changes.

## Use

```sh
attic scan E:\                      # list everything, then hash files whose content is unknown
attic scan E:\Files --no-hash       # list only; a later scan hashes
attic scan E:\ --log-level debug    # log every hashed file and read document too
attic search minecraft server       # every word, in the name, the path or as a name fragment
attic search werkstudent --ext pdf  # fragments match: Werkstudentenvertrag.pdf
attic search --volume Data --ext iso
attic search notes --under E:\Files --json
attic search --under E:\Backups\Minecraft.7z  # what one archive holds
attic show 36331                    # one entry, its times, its ref and its other copies
attic show 3f9a1c2b4d5e6f70         # a ref: every place that content lives
attic metadata 36331                # embedded tags, including dimensions, dates and authors
attic text 36331                    # the words read from a document, for reading or quoting
attic volumes                       # known disks, mounted or not, and their last scan
attic scans --volume Data            # scan history: each phase's time, what it found
attic dupes --same-volume           # copies that share a disk, largest waste first
attic skips                         # what the newest scan left out, grouped by reason
attic skips --reason unreadable     # the paths themselves
```

A scan commits every couple of seconds, so search sees it while it runs. Interrupting it with Ctrl+C, or killing the process, keeps finished work; the same command continues where hashing stopped. Rescanning an unchanged disk writes almost nothing and takes seconds.

Each scan writes a JSON-lines log to `%LOCALAPPDATA%\attic\logs`, named in its summary: the phases with their times and counts, each archive, failures as warnings, and every hashed file and read document at `--log-level debug`. The summary also names the slowest archives and documents. Logs older than 90 days are removed.

Results show where a file can be opened now (`E:\Files\x.zip`) or the volume it lives on when the disk is unplugged (`Data:\Files\x.zip  (offline)`).

After hashing, a scan lists what zip, 7z, rar and tar archives hold, and the archives inside those, without asking for passwords. Search shows those files after the plain hits, inside the copy of the archive that can be opened now: `E:\Backups\Minecraft.7z :: MinecraftServer.rar :: world\level.dat`. Each archive is read once however many disks hold it. Nested archives are copied into private `aqt-attic/scan-*` workspaces below the temporary folder and deleted right after listing. Workspaces abandoned for more than a day are removed only when their file lock is free. Failed stale cleanup logs a warning and leaves the scan running. Existing `attic-*` files in the shared temporary folder are left alone. The temporary folder must already exist. To scan C: when system temp is there, set `[archives] temp` to an existing directory on another disk. Metadata inherits that directory. Setting `archives.depth = 1` removes only the nested-archive scratch requirement; metadata still needs a separate disk or `metadata.enabled = false`.

It also reads documents for their words: text files, Markdown, CSV, HTML, Word, Excel, PowerPoint, OpenDocument and PDFs with a text layer. Matching documents follow file and archive hits in search, with the passage that matched. The first 1 MB of each document's text is kept. Scanned PDFs wait for an explicit OCR pass, and source code and configuration files are never read.

The metadata phase uses [ExifTool](https://exiftool.org/) in batches for images, PDFs, Office and OpenDocument files, audio and video. Install `exiftool` on PATH, or set `metadata.exiftool`. If it is missing, scanning continues and records `metadata_unavailable`; the next scan tries again. `attic metadata <id|ref>` prints the embedded tags, and `search` includes matching metadata after document hits.

External tools read verified temporary copies, made through Attic's last-access-preserving reader. Set `metadata.temp`, which otherwise inherits `archives.temp`, to an existing directory on another disk when scanning the disk that holds the system temp directory. Each batch holds up to 256 MiB of copies, or one larger file up to `metadata.max_bytes`, then removes them. The default file cap is 1 GiB. This reads each eligible file in full again after hashing. Files above the cap, failed reads and files changed since hashing remain eligible on the next scan. A corrupt file's metadata failure is recorded once per content. A timeout or malformed batch is retried one file at a time; a file that still fails stays pending without blocking the rest.

## OCR and image descriptions

`scan` never runs AI. `enrich` requires a task and a selection: entry ids or refs from `search`, or `--under` for a folder. It attempts at most 20 unique contents by default. Files must already be hashed and their volumes online. Current exclusions and name-only rules still apply.

```powershell
attic enrich --task ocr --under E:\Scans --limit 20
attic enrich 36331 36332 --task describe --provider openai --model YOUR_VISION_MODEL
attic analysis 36331 --json
attic search submarine --json
```

OCR defaults to local [Tesseract](https://github.com/tesseract-ocr/tesseract). Install `tesseract` and Poppler's `pdftoppm` on PATH. It reads images and PDFs that the text phase marked `needs_ocr`, using the configured languages and first 20 pages by default. PDF pages render at 300 dpi; page count and the per-file deadline bound the OCR pass. Partial page failures or page/text limits mark the result `truncated`.

Descriptions default to an [OpenAI-compatible chat endpoint](https://docs.ollama.com/api/openai-compatibility), with Ollama's `http://localhost:11434/v1` as the initial URL. Select a vision model with `--model`; there is no default model. The same provider supports `--task ocr` on images. Remote endpoints receive the selected image bytes and the prompt. Set `ai.api_key_env` to the name of an environment variable holding the key when needed. For OpenAI models that require `max_completion_tokens`, set `ai.token_parameter` accordingly. Remote endpoints require HTTPS. HTTP is accepted only for localhost and loopback IPs, including the default local Ollama endpoint. Redirects are refused.

An authenticated, recent [Codex CLI](https://developers.openai.com/codex/noninteractive) can handle a small selection with `--provider codex --model MODEL`. Each file runs through `codex exec` in its scratch directory with an ephemeral session and no approvals. Shell, local-image, browser, computer-use, app, plugin and subagent tools are disabled. A [permission profile](https://learn.chatgpt.com/docs/permissions) limits command reads to scratch and minimal runtime paths, with command networking disabled. User config, rules, project instructions and host skill discovery are disabled. Strict configuration checking rejects unsupported settings; this policy was verified with Codex 0.162.1. This uses the CLI's configured authentication and is limited to 20 contents per command. On Windows, `ai.codex` must point to the native `codex.exe`, rather than a `.cmd` or `.bat` shim. A Codex command failure stops the selection without storing per-content failures.

Both vision providers accept PNG, JPEG, GIF and WebP, up to 20 MiB per image. Tesseract also accepts TIFF and BMP. Every provider reads a verified temporary copy; `ai.temp` inherits `archives.temp` and must be on another disk. `ai.max_bytes` defaults to 64 MiB, and each provider call has a five-minute deadline. Codex and ExifTool run in a process group on Unix and a kill-on-close job on Windows, so cancellation also stops launcher children. Failed copy cleanup is retried by the scratch sweeper.

Results belong to content, so duplicates reuse them. Each task, provider endpoint, model and prompt policy has a separate row with status, elapsed time and reported model. Successful rows are reused. New work runs before failed retries, so a permanently failing file cannot block the rest of a bounded selection. Provider outages, missing models, authentication failures and rate limits stop the run without writing content failures. Unsupported input is skipped. `--force` repeats completed work without destroying a good answer if the new request fails. Ctrl+C keeps each completed result. `analysis` compares stored results, and `search` includes OCR and descriptions even with the source disk unplugged.

To compare models, run the same small list of ids or refs once for each model, then inspect `analysis` for accuracy and latency. No vision model has been selected yet: the remaining evaluation is on your own images. The automated tests cover provider behavior and real Tesseract OCR on a synthetic invoice; they do not measure vision-model quality.

## Configuration

One TOML file at `%APPDATA%\attic\config.toml`, or another with `scan --config` or `enrich --config`. `attic config` prints the effective rules. Patterns use gitignore syntax and ignore case; the built-in defaults exclude dependency and build folders, game libraries and Windows system folders, and keep BitLocker recovery-key files to their names. A pattern with a slash inside is anchored at the volume root, so write `**/name/` to match at any depth. On Windows a backslash cannot escape a bracket; match a literal `[` with a class, as in `Fotos [[]2019]/`.

```toml
exclude = ["*.iso"]
name_only = ["*.kdbx"]
hash_max_bytes = 0   # 0 hashes every file

[archives]
depth = 2                      # archive levels opened, the one on disk included; 0 reads none
unpack_max_bytes = 4294967296  # largest nested archive copied out to be listed

[text]
max_bytes = 67108864           # largest document read for its words

[metadata]
enabled = true
exiftool = "exiftool"
max_bytes = 1073741824         # largest file copied for metadata; 0 is no limit
temp = ""                      # inherits archives.temp; existing directory on another disk

[ai]
provider = ""                 # task default: tesseract for OCR, openai for descriptions
endpoint = "http://localhost:11434/v1"
model = ""                    # choose a vision model explicitly
api_key_env = ""              # environment variable name, never the key itself
max_bytes = 67108864          # largest verified copy; 0 is no limit
temp = ""                     # inherits archives.temp
timeout_seconds = 300
max_tokens = 4096
token_parameter = "max_tokens" # or max_completion_tokens
ocr_lang = "eng"              # e.g. deu+eng; install corresponding language data
ocr_max_pages = 20
tesseract = "tesseract"
pdftoppm = "pdftoppm"
codex = "codex"

[[volume]]
label = "Data"        # or id = "<uuid from attic volumes>"
exclude = ["/Games/"]
```

## Develop

```sh
mise run attic:check                # vet, test and lint, Windows and Linux builds
```

The integration tests use real ExifTool and Tesseract when installed; CI requires both plus Poppler, and a separate Windows job tests subprocess cleanup. HTTP and Codex providers use local test doubles, with no paid API calls. Set `ATTIC_TEST_DATABASE_URL` to a superuser on a disposable ParadeDB server. pgtestdb clones a migrated template for each test and drops successful test databases. Failed test databases remain available for inspection. Tests skip when the variable is unset or no server is listening, unless `ATTIC_REQUIRE_DB=1` or `CI` requires them. `DATABASE_URL` only configures the application.
