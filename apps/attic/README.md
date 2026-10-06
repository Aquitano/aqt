# attic

Search the files on backup disks and USB sticks, including disks that are not plugged in. attic records every file's metadata and a BLAKE3 hash in ParadeDB and never writes to the disks it reads. See [DESIGN.md](DESIGN.md) for the identity model and the roadmap.

Scanning runs on Windows. Search works from any machine that can reach the database.

## Setup

```sh
docker compose up -d --wait        # ParadeDB on 127.0.0.1:5436, or: mise run attic:db
go build -o "$USERPROFILE/.local/bin/attic.exe" ./cmd/attic
```

`DATABASE_URL` defaults to `postgres://attic:attic@localhost:5436/attic?sslmode=disable`. Migrations run on start.

## Use

```sh
attic scan E:\                      # list everything, then hash files whose content is unknown
attic scan E:\Files --no-hash       # list only; a later scan hashes
attic search minecraft server       # every word, in the name, the path or as a name fragment
attic search werkstudent --ext pdf  # fragments match: Werkstudentenvertrag.pdf
attic search --volume Data --ext iso
attic search notes --under E:\Files --json
attic search --under E:\Backups\Minecraft.7z  # what one archive holds
attic show 36331                    # one entry, its times, its ref and its other copies
attic show 3f9a1c2b4d5e6f70         # a ref: every place that content lives
attic text 36331                    # the words read from a document, for reading or quoting
attic volumes                       # known disks, mounted or not, and their last scan
attic dupes --same-volume           # copies that share a disk, largest waste first
attic skips                         # what the newest scan left out, grouped by reason
attic skips --reason unreadable     # the paths themselves
```

A scan commits every couple of seconds, so search sees it while it runs. Interrupting it with Ctrl+C, or killing the process, keeps finished work; the same command continues where hashing stopped. Rescanning an unchanged disk writes almost nothing and takes seconds.

Results show where a file can be opened now (`E:\Files\x.zip`) or the volume it lives on when the disk is unplugged (`Data:\Files\x.zip  (offline)`).

After hashing, a scan lists what zip, 7z, rar and tar archives hold, and the archives inside those, without asking for passwords. Search shows those files after the plain hits, inside the copy of the archive that can be opened now: `E:\Backups\Minecraft.7z :: MinecraftServer.rar :: world\level.dat`. Each archive is read once however many disks hold it. Nested archives are copied to the temporary folder while they are listed and deleted right after. Because that folder is on C:, a scan of a C: folder needs `[archives] temp` on another disk, or `depth = 1`.

It also reads documents for their words: text files, Markdown, CSV, HTML, Word, Excel, PowerPoint, OpenDocument and PDFs with a text layer. Matching documents come last in search, with the passage that matched. The first 1 MB of each document's text is kept. Scanned PDFs wait for OCR, and source code and configuration files are never read.

## Configuration

One TOML file at `%APPDATA%\attic\config.toml`, or another with `scan --config`. `attic config` prints the effective rules. Patterns use gitignore syntax and ignore case; the built-in defaults exclude dependency and build folders, game libraries and Windows system folders, and keep BitLocker recovery-key files to their names. A pattern with a slash inside is anchored at the volume root, so write `**/name/` to match at any depth. On Windows a backslash cannot escape a bracket; match a literal `[` with a class, as in `Fotos [[]2019]/`.

```toml
exclude = ["*.iso"]
name_only = ["*.kdbx"]
hash_max_bytes = 0   # 0 hashes every file

[archives]
depth = 2                      # archive levels opened, the one on disk included; 0 reads none
unpack_max_bytes = 4294967296  # largest nested archive copied out to be listed

[text]
max_bytes = 67108864           # largest document read for its words

[[volume]]
label = "Data"        # or id = "<uuid from attic volumes>"
exclude = ["/Games/"]
```

## Develop

```sh
mise run attic:check                # vet, test and lint, Windows and Linux builds
```

Tests run against the compose database in a throwaway schema and skip when nothing listens on the port. `ATTIC_REQUIRE_DB=1` or `CI` makes a missing database a failure.
