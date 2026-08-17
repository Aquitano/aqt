# aqt-bank

Personal message archive: every message from every source in one Postgres, full-text searchable from a CLI by me and my agents. See [DESIGN.md](DESIGN.md) for architecture and roadmap.

## Quickstart

```sh
docker compose up -d          # ParadeDB (Postgres + pg_search)
go build -o bank ./cmd/bank

./bank import whatsapp "WhatsApp Chat with Alice.zip"
./bank search "that invoice" --from alice --since 2024-01-01
./bank search "typo-tolerannt query" --json   # agents consume this
./bank show 42
./bank stats
```

Config via env (see `.env.example`): `DATABASE_URL`, `BANK_DATA_DIR` (blobs, raw archives, inbox; default `~/.local/share/aqt-bank`).

Schema migrations are embedded and run automatically on startup.
