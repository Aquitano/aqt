# Deploying to the VPS

Target: one VPS running everything in containers, Postgres data and the message archive on a LUKS-encrypted volume, encrypted offsite backups with restic, cron-driven sync.

Trust model, unchanged by any of this: encryption protects disks at rest and backups, and a running box is readable by whoever runs the hardware. What the container buys is narrower and worth being precise about — the process serving a lifetime of private correspondence over a network port runs as a non-root user, with a read-only root filesystem, no capabilities, and an image that contains one static binary and no shell. It reduces what a bug in that process can reach. It does not make the box trustworthy.

## 1. Encrypted data volume

Attach a block volume (e.g. `/dev/sdb`), then:

```sh
cryptsetup luksFormat /dev/sdb
cryptsetup open /dev/sdb bankdata
mkfs.ext4 /dev/mapper/bankdata
mkdir -p /data && mount /dev/mapper/bankdata /data
```

Deliberately not in `/etc/crypttab` with a keyfile — a keyfile on the root disk would defeat the point. After a reboot, unlock manually:

```sh
cryptsetup open /dev/sdb bankdata && mount /dev/mapper/bankdata /data && \
    docker compose -f /opt/aqt-bank/docker-compose.yml up -d
```

## 2. App + database

Everything runs in containers. The host needs Docker and the repo, and nothing else — no Go toolchain, no `bank` binary, no service account able to read the archive.

```sh
apt install docker.io docker-compose-v2
git clone <repo> /opt/aqt-bank && cd /opt/aqt-bank
```

The data directory holds blobs, raw archives, the inbox and the token file, and must be owned by the uid the container runs as (65532, the image's `nonroot` user):

```sh
mkdir -p /data/aqt-bank /data/pgdata
chown -R 65532:65532 /data/aqt-bank
```

Write `/opt/aqt-bank/.env` (`chmod 600` — it holds the database password):

```sh
COMPOSE_PROFILES=server           # add ",ocr" to also read scanned documents
POSTGRES_PASSWORD=<strong-password>
BANK_PG_DIR=/data/pgdata          # Postgres on the encrypted volume
BANK_DATA_DIR=/data/aqt-bank      # blobs, archives, inbox, tokens
BANK_LISTEN=100.x.y.z:8480        # the box's tailscale address — never 0.0.0.0
TZ=Europe/Berlin                  # date filters and WhatsApp timestamps are local time
```

Then bring up both services:

```sh
docker compose up -d --build
docker compose ps
curl -s http://100.x.y.z:8480/healthz     # {"ok":true}
```

`COMPOSE_PROFILES` decides what that starts. Unset it and `docker compose up` starts only Postgres, which is what local development wants.

What the server container is allowed to do, and why it is worth having it in a container at all:

- The image is `distroless/static`: one static binary, the CA bundle, and nothing else. No shell, no package manager, no libc, so there is nothing to pivot to.
- It runs as uid 65532, never root.
- Its root filesystem is read-only. The process only ever writes under `/data`, which is the one volume mounted read-write.
- Every Linux capability is dropped and `no-new-privileges` is set, so nothing in the container can gain any.
- It reaches Postgres over the compose network. The `127.0.0.1:5433` publish is for `psql` and `pg_dump` on the box itself; nothing else can reach the database.
- The port is published on the tailnet address only. `bank serve` has no TLS by design, so publishing on `0.0.0.0` would put the archive on the public internet — the default in `docker-compose.yml` is loopback so a mistyped `.env` fails closed.

Run CLI commands with the same image, so they see the same data directory and the same database:

```sh
cd /opt/aqt-bank
docker compose run --rm bank stats
docker compose run --rm bank verify
docker compose run --rm bank token list
```

### Upgrading

```sh
cd /opt/aqt-bank
docker compose exec -T db pg_dump -U bank -Fc bank > /data/backup/pre-upgrade.dump.tmp &&
    mv /data/backup/pre-upgrade.dump.tmp /data/backup/pre-upgrade.dump &&
    git pull &&
    docker compose up -d --build
```

Migrations run when the server starts, and in any `docker compose run` that opens the database first. Take the dump before that, because no migration has a down step. The chain stops if the dump fails, so a stopped database never leaves a truncated dump behind and never gets upgraded without one.

Mail imported before the mail metadata migrations (0011 to 0013) stays ungrouped until it is rebuilt. Proton and other EML or MBOX mail shows one conversation per message. Gmail keeps its threads but has no folders or provenance. Rebuild each mail source once, reading the preview before applying it:

```sh
docker compose run --rm bank mail rebuild --source gmail
docker compose run --rm bank mail rebuild --source gmail --apply
docker compose run --rm bank verify --source gmail
```

Repeat for `proton` and any other mail source. [MAIL.md](MAIL.md) explains the report.

### Text inside attachments

Importing already reads PDFs with a text layer, Office and OpenDocument files, HTML and plain text, so those are searchable without doing anything. Scanned pages and images are recorded as `needs_ocr`, because the tools that read pixels are deliberately not in the server's image.

Check what OCR would actually buy before turning it on. Documents produced by software carry text layers already, and if that is most of the archive the answer is nothing:

```sh
docker compose run --rm bank attachment stats
```

If the `needs_ocr` row is worth it, one setting turns it on. In `.env`:

```sh
COMPOSE_PROFILES=server,ocr
#BANK_OCR_INTERVAL=30m
```

```sh
docker compose up -d --build
```

That starts `bank-ocr`, a worker that drains the queue every half hour and stores the text it reads. Nothing else changes: an import records a scanned page as `needs_ocr`, the worker picks it up on its next pass, and the document becomes searchable without anyone running a command.

`bank-ocr` shares the data directory and the database with the server, runs as the same non-root uid on a read-only rootfs, and publishes nothing. It is built from its own image because tesseract and poppler are a C++ image stack and a libc, which the process listening on a port should not carry. DESIGN.md has the rest of the reasoning.

For a one-off pass instead of the worker, leave the profile off and run it directly:

```sh
docker compose run --rm bank-ocr extract --ocr
```

Other languages are apt packages in the `ocr` stage of the `Dockerfile` (`tesseract-ocr-deu` and so on), then `--lang deu+eng`.

Transcriptions can also come from elsewhere — a model on the laptop, or a person:

```sh
export BANK_URL=... BANK_TOKEN=...
bank attachment list --status needs_ocr --json     # the work queue
bank fetch <sha256> -o page.png                    # the bytes
bank attachment text <sha256> --set transcript.txt # store it, marked "manual"
```

Text stored that way is never overwritten by a later automatic pass. `bank extract --ocr` also works straight from the laptop against `BANK_URL`, which is the option worth knowing if you have better tools there than tesseract: it downloads each pending blob, runs whatever is installed locally, and stores only the text.

### Healing mail bodies

Some senders write the message only in the HTML part and fill the plain alternative with a "open this in an HTML viewer" template. The parser used to store that template as the body; it now prefers the HTML. Mail imported before that keeps the stub, and the text is still in the archived raw:

```sh
docker compose run --rm bank reimport mbox --heal-bodies          # report only
docker compose run --rm bank reimport mbox --heal-bodies --apply  # write the longer bodies
docker compose run --rm bank reimport mbox --heal-bodies --source proton
```

It re-parses every archived `.mbox` and `.eml` of the source (default `gmail`), matches each message to its row by Message-ID, and replaces the body only where the re-parse is strictly longer — never shorter, never equal, nothing but the body column. **Dry run is the default**; read the report before passing `--apply`. Run it after a parser change that affects `body()`, not on a schedule: a healed body stays healed, and a second pass finds nothing.

## 3. Gmail authorization on a headless box

Put the OAuth client JSON at `/data/aqt-bank/gmail/client_secret.json` first (`chown 65532:65532` it). The flow needs a browser to reach the callback listener, and the container's own loopback is not reachable from anywhere, so bind it to the container's interfaces and publish that on the host's loopback:

```sh
# on the VPS
docker compose run --rm --service-ports -p 127.0.0.1:8085:8085 bank \
    auth gmail --port 8085 --bind 0.0.0.0
```

```sh
# on the laptop, then open the printed URL
ssh -L 8085:127.0.0.1:8085 vps
```

The redirect URL stays `http://127.0.0.1:8085/` — that is what Google registers for a Desktop client, and the laptop's browser resolves it to its own end of the tunnel. `--bind` defaults to loopback, so running `bank auth gmail` directly on a machine with a browser is unchanged.

Alternatively run `bank auth gmail` on the laptop and copy the resulting `gmail/` directory into `/data/aqt-bank/`; only `token.json` and `client_secret.json` matter.

## 4. ProtonMail

Install the official `proton-mail-export` CLI on the VPS. Its EML output directory feeds `bank import eml` (idempotent, so re-exporting is fine).

## 5. Remote CLI (`bank serve`)

Running the CLI on the laptop against a remote `DATABASE_URL` splits the archive in half: rows land in the VPS Postgres, blobs and raw archives land on the laptop. Instead, point the laptop at the server container with `BANK_URL`.

There is no TLS in `bank serve` — it is published on the box's Tailscale address and the tailnet does transport security. That is what `BANK_LISTEN` in section 2 sets.

Firewall: nothing on the public interface, everything on the tailnet.

```sh
ufw default deny incoming
ufw allow in on tailscale0
ufw allow 41641/udp        # tailscale itself
ufw enable
```

Tokens live in `$BANK_DATA_DIR/tokens` as `name:sha256`, are checked on every request, and revocation is immediate:

```sh
docker compose run --rm bank token new laptop      # prints the token once — copy it now
docker compose run --rm bank token list
docker compose run --rm bank token revoke laptop
```

**`bank token` has to run against the server's own data directory.** Running it any other way — a stray binary on the host, an `ssh vps bank token new` that never reads `.env` — writes the digest somewhere the server never looks, and every request then 401s with a token that looks perfectly valid. Going through `docker compose run` is what guarantees the same volume; the container has `BANK_DATA_DIR=/data` baked in.

```sh
# on the laptop
export BANK_TOKEN=$(ssh vps 'cd /opt/aqt-bank && docker compose run --rm -T bank token new laptop')
```

`bank token new` and `bank token list` print the resolved token file to stderr (`token stored in /data/tokens`), which is what to check first when a token is rejected — the digests themselves are never shown. Command substitution captures stdout only, so the token still assigns cleanly; `-T` keeps Docker from allocating a TTY that would corrupt it.

On the laptop:

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
export BANK_TOKEN=bank_...
bank import whatsapp "WhatsApp Chat with Alice.zip"   # uploads, VPS stores rows + blobs
bank search "that invoice"
bank contact list
bank fetch <sha256> -o invoice.pdf
```

`sync`, `token`, `verify`, `reimport`, `import inbox` and `mail rebuild` stay server-side and refuse to run with `BANK_URL` set, rather than acting on the wrong box. `auth` and `serve` are server-side too but do not refuse: running `bank auth gmail` on the laptop and copying `gmail/` over is a documented option (section 3), and `bank serve` is the server.

## 6. Cron

Every scheduled job runs the same image as a one-off container, so it sees the same volume, the same database and the same timezone as the server.

```cron
17 *  * * *  cd /opt/aqt-bank && docker compose run --rm -T bank sync >> /var/log/bank.log 2>&1
40 3  * * *  cd /opt/aqt-bank && docker compose run --rm -T bank extract >> /var/log/bank.log 2>&1
*/15 * * * *  cd /opt/aqt-bank && docker compose run --rm -T bank import inbox >> /var/log/bank.log 2>&1
0 5  * * 0  cd /opt/aqt-bank && docker compose run --rm -T bank import eml /data/inbox/proton >> /var/log/bank.log 2>&1
```

`-T` matters in cron: without a TTY to allocate, Docker otherwise fails.

The nightly `bank extract` is a backstop, not the main path — imports already read what they can. It catches whatever a bounded post-import batch left behind, and picks up content whose extractor only arrived with a later version. It does not do OCR; that is the `ocr` profile above.

Manual sources (WhatsApp zips, Discord package, LinkedIn export, YouTube Takeout): scp into `/data/aqt-bank/inbox/<kind>/` and let the sweep pick them up, or run the import from the laptop with `BANK_URL` set (section 5) so rows and blobs still land together. Swept files move to `inbox/.done/<kind>/`; ones no importer could read move to `inbox/.rejected/<kind>/`. A file left in place means the import failed operationally (database down, disk full) and the next sweep retries it.

Files dropped by hand need to be readable by uid 65532:

```sh
chown -R 65532:65532 /data/aqt-bank/inbox
```

## 7. Backups (restic, encrypted)

Back up a `pg_dump` plus the data dir — not the live `pgdata` directory:

```sh
restic -r s3:s3.example.com/aqt-bank-backup init   # once; store the restic password offline

# /usr/local/bin/bank-backup — dump to a temp file and move into place only on
# success, so a failed pg_dump (e.g. DB down after an unattended reboot, since
# the LUKS unlock is manual) can never truncate the last good dump; set -e
# makes any failure skip the restic forget/prune, so old good snapshots survive.
#!/bin/sh
set -eu
docker compose -f /opt/aqt-bank/docker-compose.yml exec -T db pg_dump -U bank -Fc bank > /data/backup/bank.dump.tmp
mv /data/backup/bank.dump.tmp /data/backup/bank.dump
restic -r s3:... backup /data/backup/bank.dump /data/aqt-bank
restic -r s3:... forget --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --prune
```

```cron
30 4 * * *  /usr/local/bin/bank-backup >> /var/log/bank-backup.log 2>&1
```

Restore drill: `restic restore latest`, `pg_restore -d bank bank.dump`, point `BANK_DATA_DIR` at the restored dir, then `docker compose run --rm bank verify` — it walks every message, hashes every attachment blob and reports anything the database claims but the disk no longer has. Do this once before trusting the setup.

Include `archive/<source>/.mail-contexts/` in the archive backup. These hidden directories preserve mailbox observations and supplied mail identifiers that raw EML alone cannot recover. Verification checks their digests and raw references. After restoring the database and files, `bank mail rebuild --source <source>` previews mail projection recovery without writes. Add `--apply` only after reviewing the report. Rebuild checkpoints live in the restored database, not on the collector laptop. See [MAIL.md](MAIL.md).

```sh
docker compose run --rm bank verify           # read-only report
docker compose run --rm bank verify --heal    # rebuild what the archived raw inputs still contain
```

## 8. Full reset (wipe the archive, keep the deployment)

For starting the archive over — bad test data, a re-import from scratch — without
touching what is annoying to rebuild: API tokens, the Gmail OAuth material, and
the stack itself. Everything below runs on the VPS in `/opt/aqt-bank`.

```sh
docker compose stop bank                       # no writes while wiping; db stays up

docker compose exec -T db psql -U bank -d bank -c \
  "truncate messages, blob_text, contacts, message_id_collapsed, sync_state,
   import_reports, mailboxes, mail_thread_nodes, mail_thread_conflicts,
   mail_thread_aliases, mail_rebuild_progress, library_items,
   library_collections, library_files, library_pages restart identity cascade;"

# blobs, raw import archives and upload staging (host side; BANK_DATA_DIR
# from .env). tokens/, gmail/ and inbox/ deliberately survive.
rm -rf /data/aqt-bank/blobs /data/aqt-bank/archive /data/aqt-bank/tmp

docker compose up -d                           # bank serve comes back empty
docker compose run --rm bank stats             # every source should be gone
```

The cascade also clears dependent attachments, mailbox membership, library activity,
tracking state, collection snapshots, edit history, item links, and provenance evidence.
This includes `library_activity_aliases` and `library_activity_evidence`.
Library ratings, statuses, notes, tags and collection edits exist only in Postgres,
not in the raw archive, so a re-import does not bring them back.
`schema_migrations` stays, so no migration re-runs; `restart identity` resets
generated row IDs. If a backup cron from §7 is
live, take one last snapshot first — the wipe is exactly the kind of action the
backups exist for.
