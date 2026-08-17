# aqt-bank

Personal message archive: every message from every source in one Postgres, full-text searchable from a CLI by me and my agents. See [DESIGN.md](DESIGN.md) for architecture and roadmap.

## Quickstart

```sh
docker compose up -d          # ParadeDB (Postgres + pg_search)
go build -o bank ./cmd/bank

./bank auth gmail             # once; then:
./bank sync                   # incremental Gmail pull (cron this)

./bank import whatsapp "WhatsApp Chat with Alice.zip"
./bank import eml ~/proton-export/            # proton-mail-export output
./bank import mbox takeout/All\ mail.mbox     # Gmail Takeout
./bank import discord package.zip             # GDPR data package
./bank import linkedin Complete_LinkedInDataExport.zip
./bank import chatgpt chatgpt-export.zip        # ChatGPT data export
./bank import claude claude-export.zip          # Claude.ai data export
./bank import claude-code ~/.claude/projects    # Claude Code transcripts
echo '{"body":"note to self","thread":"ideas"}' | ./bank import json --source notes -

./bank search "that invoice" --from alice --since 2024-01-01
./bank search "typo-tolerannt query" --json   # agents consume this
./bank show 42
./bank stats
```

Deployment (VPS, LUKS, restic, cron): [DEPLOY.md](DEPLOY.md).

Config via env (see `.env.example`): `DATABASE_URL`, `BANK_DATA_DIR` (blobs, raw archives, inbox; default `~/.local/share/aqt-bank`).

Schema migrations are embedded and run automatically on startup.
