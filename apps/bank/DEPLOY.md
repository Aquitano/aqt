# Deploying to the VPS

Target: one VPS running everything in containers, Postgres data and the message archive on a LUKS-encrypted volume, encrypted offsite backups with restic, sync and text extraction as jobs inside the server.

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
    docker compose -f /opt/aqt/apps/bank/docker-compose.yml up -d
```

## 2. App + database

Everything runs in containers. The host needs Docker and the repo, and nothing else — no Go toolchain, no `bank` binary, no service account able to read the archive.

```sh
apt install docker.io docker-compose-v2
git clone <monorepo-url> /opt/aqt
cd /opt/aqt/apps/bank
```

The data directory holds blobs, which include the raw inputs, the inbox and the token file, and must be owned by the uid the container runs as (65532, the image's `nonroot` user):

```sh
mkdir -p /data/aqt-bank /data/pgdata
chown -R 65532:65532 /data/aqt-bank
```

Write `/opt/aqt/apps/bank/.env` (`chmod 600` — it holds the database password):

```sh
COMPOSE_PROFILES=server           # add ",ocr" to also read scanned documents
POSTGRES_PASSWORD=<strong-password>
BANK_PG_DIR=/data/pgdata          # Postgres on the encrypted volume
BANK_DATA_DIR=/data/aqt-bank      # blobs, inbox, tokens
BANK_LISTEN=100.x.y.z:8480        # the box's tailscale address — never 0.0.0.0
TZ=Europe/Berlin                  # date filters and WhatsApp timestamps are local time
```

Start Postgres, then provision the restricted SQL login:

```sh
docker compose up -d db
docker compose exec -T db psql -U bank -d bank -v ON_ERROR_STOP=1 < deploy/query-role.sql
docker compose exec db psql -U bank -d bank
```

At the psql prompt, run `\password bank_query`, enter a new password twice, then
run `\q`. The password prompt does not echo or put the password in shell history.
Add `BANK_QUERY_DATABASE_URL=postgres://bank_query:<URL-encoded-password>@db:5432/bank?sslmode=disable`
to `.env`. Use a distinct password and percent-encode URL-reserved characters.
Keep `.env` mode 0600. Do not grant this login membership in the ingestion role,
server-file roles, or any other role. Do not grant `pg_read_all_data`; it also
permits reading sensitive system catalogs such as `pg_authid`.

Start the server:

```sh
BANK_VERSION=$(git rev-parse HEAD) docker compose up -d --build
docker compose ps
curl -s http://100.x.y.z:8480/healthz     # {"ok":true,"schema_version":1,"queues":[...]}
```

`COMPOSE_PROFILES` decides what that starts. Unset it and `docker compose up` starts only Postgres, which is what local development wants.

What the server container is allowed to do, and why it is worth having it in a container at all:

- The image is `distroless/static`: one static binary, the CA bundle, and nothing else. No shell, no package manager, no libc, so there is nothing to pivot to.
- It runs as uid 65532, never root.
- Its root filesystem is read-only. The process only ever writes under `/data`, which is the one volume mounted read-write.
- Every Linux capability is dropped and `no-new-privileges` is set, so nothing in the container can gain any.
- It reaches Postgres over the compose network. The `127.0.0.1:5433` publish is for `psql` and `pg_dump` on the box itself; nothing else can reach the database. Disk scans from the PC write through `bank serve` too (section 5), so Postgres never needs another publish.
- The port is published on the tailnet address only. `bank serve` has no TLS by design, so publishing on `0.0.0.0` would put the archive on the public internet — the default in `docker-compose.yml` is loopback so a mistyped `.env` fails closed.

Run CLI commands with the same image, so they see the same data directory and the same database:

```sh
cd /opt/aqt/apps/bank
docker compose run --rm bank stats
docker compose run --rm bank verify
docker compose run --rm bank token list
```

### Upgrading

Run this entire block together. Its subshell stops on any failed command,
including the backup, role provisioning, or rebuild. On the first upgrade, if
`.env` has no query connection, psql prompts for the `bank_query` password twice,
then `vi` opens `.env`. Add the query URL described in section 2 before saving and
exiting. Cancel the password prompt or exit the editor with `:cq` to stop the
upgrade. Provisioning uses psql directly and does not run app migrations.

```sh
(
    set -eu
    cd /opt/aqt/apps/bank
    mkdir -p /data/backup
    docker compose exec -T db pg_dump -U bank -Fc bank > /data/backup/pre-upgrade.dump.tmp
    mv /data/backup/pre-upgrade.dump.tmp /data/backup/pre-upgrade.dump
    docker compose --profile server --profile ocr stop bank bank-ocr
    git pull
    docker compose exec -T db psql -U bank -d bank -v ON_ERROR_STOP=1 < deploy/query-role.sql
    if ! grep -q '^BANK_QUERY_DATABASE_URL=.' .env; then
        docker compose exec db psql -U bank -d bank -v ON_ERROR_STOP=1 -c '\password bank_query'
        vi .env
        chmod 600 .env
        grep -q '^BANK_QUERY_DATABASE_URL=.' .env
    fi
    BANK_VERSION=$(git rev-parse HEAD) docker compose build
    docker compose run --rm bank migrate
    BANK_VERSION=$(git rev-parse HEAD) docker compose up -d
    docker compose exec bank bank healthcheck
)
```

The ingestion connection still runs migrations and imports. The separate query
connection is validated at startup. A missing query URL disables ad-hoc SQL; an
unsafe configured login fails startup.

Tern records the schema version in `public.schema_version`, and River records
its job tables' version in `river_migration`. Restore the pre-upgrade dump to
roll back a schema change.

Migrations run in `bank migrate` and when the server starts, River's after the
app's. Every other command, including `bank worker`, stops with an
error while the schema or the job tables are behind its binary, and an older
binary stops instead of writing to newer ones. A second migrator
gives up after ten seconds instead of waiting for the first. Take the dump before
migrating, because no migration has a down step. A failed dump cannot replace the
last good backup or reach the migration.

### Health and shutdown

`/healthz` checks the database with a three-second deadline, reports the schema
version it runs on, and returns 503 when it cannot connect. Its `queues` list
counts each job queue's `waiting`, `running` and `failed` jobs, with
`oldest_waiting`, the time the longest-waiting job became due. A queue whose
oldest job keeps aging has no worker. Failed jobs stay counted for seven days. The image runs `bank healthcheck` itself, so Compose can probe
the distroless server. `bank version` reports the build revision supplied through
`GIT_SHA`, which `ops/deploy.sh` sets, or else `BANK_VERSION`. SIGTERM and Ctrl-C
stop new requests and new jobs, and allow active requests and running jobs up
to 30 seconds before the database pools close. A job still running then is
cancelled: a text job is tried again later, a scheduled one at its next tick.

At most two imports parse at once, whatever their kind. An upload streams
straight into the blob store, up to 16 GiB per file.

### Text inside attachments

The server reads PDFs with a text layer, Office and OpenDocument files, HTML and plain text in text jobs that each import queues, so those are searchable moments after they land, without doing anything. Scanned pages and images are recorded as `needs_ocr` and queued for OCR, because the tools that read pixels are deliberately not in the server's image.

Check what OCR would actually buy before turning it on. Documents produced by software carry text layers already, and if that is most of the archive the answer is nothing:

```sh
docker compose run --rm bank attachment stats
```

If the `needs_ocr` row is worth it, one setting turns it on. In `.env`:

```sh
COMPOSE_PROFILES=server,ocr
```

```sh
docker compose up -d --build
```

That starts `bank-ocr`, which runs `bank worker --queue ocr`: it works the OCR jobs one at a time and stores the text it reads. Nothing else changes: an import records a scanned page as `needs_ocr`, which queues its OCR job, the worker takes it, and the document becomes searchable without anyone running a command. While the profile is off the jobs wait in the `ocr` queue, and `/healthz` shows them there. The worker leaves scheduling and retries to the server, so it only makes progress while `bank` runs too.

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
bank fetch <blake3> -o page.png                    # the bytes
bank attachment text <blake3> --set transcript.txt # store it, marked "manual"
```

Text stored that way is never overwritten by a job. `bank extract --ocr` also works straight from the laptop against `BANK_URL`, which is the option worth knowing if you have better tools there than tesseract: it downloads each pending file, runs whatever is installed locally, and stores only the text.

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

Running the CLI on the laptop against a remote `DATABASE_URL` splits the archive in half: rows land in the VPS Postgres, blobs and raw inputs land on the laptop. Instead, point the laptop at the server container with `BANK_URL`.

There is no TLS in `bank serve` — it is published on the box's Tailscale address and the tailnet does transport security. That is what `BANK_LISTEN` in section 2 sets.

Firewall: nothing on the public interface, everything on the tailnet.

```sh
ufw default deny incoming
ufw allow in on tailscale0
ufw allow 41641/udp        # tailscale itself
ufw enable
```

Tokens live in `$BANK_DATA_DIR/tokens` as `name:digest:scope`, the digest being the token's BLAKE3, are checked on every request, and revocation is immediate:

```sh
docker compose run --rm bank token new laptop      # prints the token once — copy it now
docker compose run --rm bank token list
docker compose run --rm bank token revoke laptop
```

**`bank token` has to run against the server's own data directory.** Running it any other way — a stray binary on the host, an `ssh vps bank token new` that never reads `.env` — writes the digest somewhere the server never looks, and every request then 401s with a token that looks perfectly valid. Going through `docker compose run` is what guarantees the same volume; the container has `BANK_DATA_DIR=/data` baked in.

```sh
# on the laptop
export BANK_TOKEN=$(ssh vps 'cd /opt/aqt/apps/bank && docker compose run --rm -T bank token new laptop')
```

`bank token new` and `bank token list` print the resolved token file to stderr (`token stored in /data/tokens`), which is what to check first when a token is rejected — the digests themselves are never shown. Command substitution captures stdout only, so the token still assigns cleanly; `-T` keeps Docker from allocating a TTY that would corrupt it.

A token reads, or reads and writes. `--read-only` mints one that searches and reads, including the file catalogue below `/v1/disk`, but cannot import, edit or delete; ad-hoc SQL still works, because its sessions are read-only. Each operation in `/openapi.json` that writes names the `write` role in its security requirement, and a read token calling one gets 403. Give agents `bank token new <agent> --read-only`. `bank token list` shows each token's scope. A token file the server cannot read answers 500, not 401, and the log says why.

On the laptop:

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
export BANK_TOKEN=bank_...
bank import whatsapp "WhatsApp Chat with Alice.zip"   # uploads, VPS stores rows + blobs
bank search "that invoice"
bank contact list
bank fetch <blake3> -o invoice.pdf
```

`sync`, `worker`, `token`, `verify`, `reimport` and `import inbox` stay server-side and refuse to run with `BANK_URL` set, rather than acting on the wrong box. `auth` and `serve` are server-side too but do not refuse: running `bank auth gmail` on the laptop and copying `gmail/` over is a documented option (section 3), and `bank serve` is the server.

### Disks on the PC

`bank disk` on the Windows PC the disks attach to reads and writes the file catalogue through `bank serve` with the same two variables, so the PC holds no database credentials and Postgres stays on the box's loopback. Give it a write token of its own, so revoking it stops only the PC:

```powershell
# on the PC; the token comes from: docker compose run --rm -T bank token new pc
[Environment]::SetEnvironmentVariable('BANK_URL', 'http://vps.tailnet.ts.net:8480', 'User')
[Environment]::SetEnvironmentVariable('BANK_TOKEN', 'bank_...', 'User')
bank disk scan E:\
```

Build `bank.exe` (`GOOS=windows go build ./cmd/bank`) from the commit the server runs. The server holds each scan's volume between its requests and records a scan that sends nothing for 30 minutes, or that is still open when the server stops, as interrupted; the next scan continues it. A scan whose connection drops waits for the server that long, and a new scan of the volume replaces one that has sent nothing for two minutes. Archive listings that span several requests wait under `$BANK_DATA_DIR/scans` until they are complete. An enrichment lease that the PC stops renewing runs out after two minutes. [DISKS.md](DISKS.md#through-bank-serve) has the rest.

## 6. Scheduled work

The server runs the Gmail sync every hour and sweeps the inbox every 15 minutes, as jobs in its own process, and logs each run to its JSON log (`docker compose logs bank`). A run never overlaps the previous one, and a failed run is retried by the next. `docker compose run --rm bank sync` and `docker compose run --rm bank import inbox` still work by hand, for example for a first Gmail backfill, which can outlast the job's three-hour limit.

Cron keeps what has no job: the weekly Proton export and the backups in section 7. A cron entry runs the same image as a one-off container, so it sees the same volume, the same database and the same timezone as the server.

```cron
0 5  * * 0  cd /opt/aqt/apps/bank && docker compose run --rm -T bank import eml /data/inbox/proton >> /var/log/bank.log 2>&1
```

`-T` matters in cron: without a TTY to allocate, Docker otherwise fails.

To read text again after an extractor improved, run `docker compose run --rm bank extract --status unsupported`, or `--status failed` for files whose jobs gave up.

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
docker compose -f /opt/aqt/apps/bank/docker-compose.yml exec -T db pg_dump -U bank -Fc bank > /data/backup/bank.dump.tmp
mv /data/backup/bank.dump.tmp /data/backup/bank.dump
restic -r s3:... backup /data/backup/bank.dump /data/aqt-bank
restic -r s3:... forget --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --prune
```

```cron
30 4 * * *  /usr/local/bin/bank-backup >> /var/log/bank-backup.log 2>&1
```

Restore drill: `restic restore latest`, `pg_restore -d bank bank.dump`, point `BANK_DATA_DIR` at the restored dir, then `docker compose run --rm bank verify`. It hashes every content that an attachment, a library file or a raw input refers to, and reports bytes that are missing, corrupt or the wrong size. Do this once before trusting the setup.

Mailbox observations, reply headers and threads are rows in the database dump, and `blobs/` holds the mail itself, so a restore needs no further step for mail.

```sh
docker compose run --rm bank verify           # read-only report
```

## 8. Full reset (wipe the archive, keep the deployment)

For starting the archive over — bad test data, a re-import from scratch — without
touching what is annoying to rebuild: API tokens, the Gmail OAuth material, and
the stack itself. Everything below runs on the VPS in `/opt/aqt/apps/bank`.

```sh
docker compose stop bank                       # no writes while wiping; db stays up

docker compose exec -T db psql -U bank -d bank -c \
  "truncate messages, contacts, sync_state,
   raw_inputs, mailboxes, library_items,
   library_collections, library_files, library_pages restart identity cascade;"

# blobs, which include the raw inputs, and extraction staging (host side;
# BANK_DATA_DIR from .env). tokens/, gmail/ and inbox/ deliberately survive.
rm -rf /data/aqt-bank/blobs /data/aqt-bank/tmp

docker compose up -d                           # bank serve comes back empty
docker compose run --rm bank stats             # every source should be gone
```

The cascade also clears dependent attachments, mailbox membership, library activity,
tracking state, collection snapshots, edit history, item links, and provenance evidence.
This includes `library_activity_evidence`.
Library ratings, statuses, notes, tags and collection edits exist only in Postgres,
not in the raw inputs, so a re-import does not bring them back.
`message_tombstones` is not in the list, so messages retired with `bank retire` stay out of a re-import; add it to forget them.
`contents` and `texts` are not in the list either: the catalogue of files on disks shares them, and a re-import finds the text already read for the same bytes.
`schema_version` stays, so no migration re-runs; `restart identity` resets
generated row IDs. If a backup cron from §7 is
live, take one last snapshot first — the wipe is exactly the kind of action the
backups exist for.

## 9. Switching clients to the rebuilt server

The rebuilt server starts with an empty database. Two things outside it still
describe the old server and have to be reset.

- **Tokens.** Tokens are now hashed with BLAKE3, so no token minted earlier
  verifies. Revoke each name `bank token list` shows, since a name stays taken,
  then mint a token per client with `docker compose run --rm -T bank token new
  <name>` and replace `BANK_TOKEN` on every client: laptop, disk PC, IMAP
  collector and MCP configurations.
- **IMAP collector state.** The collector skips every UID up to its checkpoints
  in its own `state_dir`, and binds each account to a digest of its mailbox and
  Bank URL. Kept as it is, the state either skips all mail collected before or
  refuses every account. On the collector's machine: check `bank imap --config
  <config> --status` for pending messages, stop the collector and its scheduled
  task, move `state_dir` aside (`state` beside the configuration in the
  example), set the new `BANK_URL` and `BANK_TOKEN`, run `--check` and `--once`,
  then start it again and delete the old state directory, which can hold
  decrypted mail. [IMAP.md](IMAP.md#switching-to-a-rebuilt-bank-server) has
  each step.
