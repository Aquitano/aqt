# Deploying to the VPS

Target: one VPS, Postgres data and the message archive on a LUKS-encrypted volume, encrypted offsite backups with restic, cron-driven sync. Trust model: protects disks at rest and backups; a running box is readable by the provider.

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
cryptsetup open /dev/sdb bankdata && mount /dev/mapper/bankdata /data && docker compose -f /opt/aqt-bank/docker-compose.yml up -d
```

## 2. App + database

```sh
apt install docker.io docker-compose-v2
git clone <repo> /opt/aqt-bank && cd /opt/aqt-bank
go build -o /usr/local/bin/bank ./cmd/bank
```

Put Postgres on the encrypted volume with a compose override (`docker-compose.override.yml`):

```yaml
services:
  db:
    volumes:
      - /data/pgdata:/var/lib/postgresql
```

Environment (e.g. `/etc/profile.d/bank.sh` or a systemd EnvironmentFile):

```sh
export DATABASE_URL="postgres://bank:<strong-password>@localhost:5433/bank?sslmode=disable"
export BANK_DATA_DIR=/data/aqt-bank
```

Set `POSTGRES_PASSWORD` in `/opt/aqt-bank/.env` to the same password. Then `docker compose up -d`.

## 3. Gmail authorization on a headless box

The OAuth flow needs a browser reaching `127.0.0.1`. Either:

- run `bank auth gmail` on the laptop with the same `BANK_DATA_DIR` layout and copy `$BANK_DATA_DIR/gmail/` to the VPS, or
- on the VPS: `bank auth gmail --port 8085`, and from the laptop `ssh -L 8085:127.0.0.1:8085 vps`, then open the printed URL in the laptop browser.

## 4. ProtonMail

Install the official `proton-mail-export` CLI on the VPS. Its EML output directory feeds `bank import eml` (idempotent, so re-exporting is fine).

## 5. Cron

```cron
17 * * * *  . /etc/profile.d/bank.sh && bank sync >> /var/log/bank.log 2>&1
0 5 * * 0   . /etc/profile.d/bank.sh && proton-mail-export --dir /data/proton-export ... && bank import eml /data/proton-export >> /var/log/bank.log 2>&1
```

Manual sources (WhatsApp zips, Discord package, LinkedIn export): scp into the inbox dir and run the matching `bank import ...` — or just run it locally on the laptop with `DATABASE_URL` pointed at the VPS (Tailscale/SSH tunnel), which also keeps blobs on the VPS only if run there; prefer running imports on the VPS so `BANK_DATA_DIR` stays in one place.

## 6. Backups (restic, encrypted)

Back up a `pg_dump` plus the data dir — not the live `pgdata` directory:

```sh
restic -r s3:s3.example.com/aqt-bank-backup init   # once; store the restic password offline

# /usr/local/bin/bank-backup:
docker exec aqt-bank-db-1 pg_dump -U bank -Fc bank > /data/backup/bank.dump
restic -r s3:... backup /data/backup/bank.dump /data/aqt-bank
restic -r s3:... forget --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --prune
```

```cron
30 4 * * *  /usr/local/bin/bank-backup >> /var/log/bank-backup.log 2>&1
```

Restore drill: `restic restore latest`, `pg_restore -d bank bank.dump`, point `BANK_DATA_DIR` at the restored dir. Do this once before trusting the setup.
