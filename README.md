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

./bank import inbox                             # sweep $BANK_DATA_DIR/inbox/<kind>/

./bank contact add alice                        # one person, many identities
./bank contact alias add alice alice@example.com "whatsapp:Alice" discord:alice_x
./bank contact messages alice                   # everything she sent or received

./bank search "that invoice" --from alice --since 2024-01-01
./bank search "the deck" --to bob               # by recipient
./bank search "that invoice" --person alice     # every identity she uses
./bank search "typo-tolerannt query" --json     # agents consume this
./bank show 42
./bank thread "Alice" --source whatsapp         # the whole conversation
./bank stats
./bank verify --heal                            # check the archive, repair what the raw inputs allow
```

## Remote use

When Postgres lives on a VPS, run the same binary there as a server (`bank serve --listen 100.x.y.z:8480`, no TLS — bind it to Tailscale) and set two env vars on the laptop. `search`, `show`, `stats`, `import` and `fetch` then go over HTTP, so rows, blobs and raw archives always land on the same box.

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
# BANK_DATA_DIR must match the server's, or the digest lands in the wrong file
export BANK_TOKEN=$(ssh vps 'BANK_DATA_DIR=/data/aqt-bank bank token new laptop')

./bank import whatsapp "WhatsApp Chat with Alice.zip"   # uploaded to the VPS
./bank fetch 9f86d081... -o photo.jpg                   # attachment bytes back
```

Agents on a client machine get the CLI handed to them by a Claude Code skill: [skill/README.md](skill/README.md).

Deployment (VPS, LUKS, `bank serve` unit, restic, cron): [DEPLOY.md](DEPLOY.md).

Config via env (see `.env.example`): `DATABASE_URL`, `BANK_DATA_DIR` (blobs, raw archives, inbox; default `~/.local/share/aqt-bank`).

Schema migrations are embedded and run automatically on startup.
