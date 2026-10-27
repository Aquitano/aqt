# aqt-turnstash

Archive and cost dashboard for AI coding-agent sessions. A small agent on each machine collects the local transcripts of Claude Code, Codex, OpenCode, Cursor, GitHub Copilot, Gemini CLI, Pi and Antigravity, redacts known secret formats, and pushes the raw records to one server. The server keeps the raw records, normalizes them into conversations, messages, tool executions and model requests, prices every request against a versioned LiteLLM catalog, indexes the text for search and serves a web UI.

## Layout

| Path                 | What it is                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/core`      | Provider ids, per-OS host paths, wire protocol schemas, normalized conversation model, redaction |
| `packages/api`       | Effect `HttpApi` definition and every request and response schema                                |
| `packages/providers` | Per-provider source discovery (agent side) and normalizers (server side), fixture tested         |
| `packages/analysis`  | Turn classification and shell-command analysis behind the insights views                         |
| `packages/pricing`   | Catalog parsing, LiteLLM refresh, model resolution, cost calculation                             |
| `apps/agent`         | The `turnstash` CLI that runs on each machine                                                    |
| `apps/server`        | Effect HttpApi server, Drizzle schema and migrations, normalize and valuation worker             |
| `apps/web`           | Vite and React dashboard on `@aqt/ui`, served by the server                                      |
| `deploy`             | Dockerfile and docker-compose files                                                              |

## Server

The server needs Postgres 17 with the `pg_search` extension for BM25 search. The `paradedb/paradedb` image ships it, and migrations fail without it. Search matches message text and the string values of each message's tool call inputs, such as shell commands and file paths.

Follow the [VPS deployment runbook](deploy/README.md) to pull a GitHub-built image, configure HTTPS and authentik, and back up or restore the database. A source-build option is also available.

The deployment Compose file publishes the server on `127.0.0.1:4320`. Put a TLS reverse proxy in front of it. Configuration is read from the environment:

| Variable                                                              | Meaning                                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                        | Postgres connection string                                                                                                                           |
| `ADMIN_TOKEN`                                                         | Required when OIDC is disabled. Ignored when `OIDC_ISSUER` is set.                                                                                   |
| `OIDC_ISSUER`                                                         | HTTPS OpenID issuer URL. Enables dashboard SSO.                                                                                                      |
| `OIDC_CLIENT_ID`                                                      | Confidential client ID, required with OIDC                                                                                                           |
| `OIDC_CLIENT_SECRET`                                                  | Client secret, required with OIDC                                                                                                                    |
| `OIDC_ADMIN_SUBJECT`                                                  | The one account allowed dashboard administration, matched against its ID token `sub`                                                                 |
| `APP_ORIGIN`                                                          | Public HTTPS origin without a trailing slash, required with OIDC                                                                                     |
| `PORT`                                                                | Listen port, default 4320                                                                                                                            |
| `WEB_DIST`                                                            | Directory with the built web UI, unset disables static serving                                                                                       |
| `WORKER_INTERVAL_MS`                                                  | Delay between normalize and valuation passes, default 2000                                                                                           |
| `NORMALIZE_SETTLE_MS`                                                 | Quiet time after a conversation's last ingested records before it is normalized, default 10000                                                       |
| `DB_STATEMENT_TIMEOUT_MS`                                             | Maximum duration of each database statement, default 30000. Must be positive. Applies to API requests and worker queries; migrations run without it. |
| `PRICING_REFRESH_HOURS`                                               | Hours between scheduled LiteLLM pricing refreshes, default 24. The first runs at startup. `0` disables them.                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                         | OTLP/HTTP collector URL, such as `http://otel-collector:4318`. Unset disables telemetry export.                                                      |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | Set each to `otlp` to export that signal. Standard `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES` also apply.                           |

Database statement timeouts return HTTP 503 for API requests. API and worker database failure logs include the error category, the failed operation (connect, query or commit) and SQLSTATE, without SQL text, parameter values, or raw error messages.

With the OTLP variables set, the server exports traces, logs, and metrics as `turnstash-server`. Each HTTP request is traced; worker passes are traced only when they normalize or price something. SQL spans carry the query text with placeholders, never parameter values, and `authorization` and `cookie` headers are redacted. The OIDC callback is not traced because its URL holds the authorization code. Metrics are named `turnstash.*`: ingested records by machine, provider and outcome, batches, normalization failures, worker pass duration and items, queue depth, unpriced requests, archive rows, time since each machine last synced, and today's and month-to-date cost by provider.

Migrations run on startup. The bundled pricing catalog is inserted on first start; `Settings > Pricing` in the UI refreshes it from LiteLLM. The scheduled refresh does the same, but only when the new catalog changes the price of a model that already appears in the archive and no other catalog is still being applied. A new catalog takes over once every request is valued under it: requests whose model it prices exactly like the live catalog keep their valuation, the rest are repriced. A change to the pricing code bumps `pricingVersion` in `packages/pricing`: the worker then reprices every valuation written by an older version, and a new catalog never keeps one. Valuations under the three most recent superseded catalogs are kept for the request inspector; older ones are deleted when a new catalog takes over and on startup.

After a parser or model-alias correction, stop the server and run `bun run --cwd apps/server reprocess` with the server's database and authentication environment; on the Compose deployment, follow [Reprocess the archive](deploy/README.md#reprocess-the-archive). Restart the server to let its worker rebuild conversations from retained raw records and recalculate the active catalog's costs. This includes records that previously produced no conversation and excludes deleted conversations. It preserves valuations for other catalog versions when the normalized request is unchanged. Totals are incomplete until the worker finishes.

The server stores each raw record without copies of what other records hold: Codex keeps only the kind of an agent message or reasoning event, which repeat a response item, and drops encrypted reasoning, which only the Codex API can read. OpenCode and Cursor JSON columns are kept as parsed values rather than escaped text. A tool result's message part no longer copies the output its tool execution holds. Inline base64 images and documents, such as screenshots and PDFs, move out of the record into a `blobs` table, stored once per distinct file as binary. The record keeps the file's media type, size and sha256, and a conversation shows an image when you open it. A file is deleted with the last record that holds it. Reprocessing applies this to records stored earlier and removes OpenCode file store records whose row the same machine's OpenCode database sent. [Reprocess the archive](deploy/README.md#reprocess-the-archive) also describes how to return the freed space to the disk.

## Agent

Install [Bun](https://bun.sh/docs/installation) 1.4.2 or newer and [GitHub CLI](https://cli.github.com/) on each machine that collects transcripts. Run the agent as the same OS user who runs your coding tools. Authenticate with an account that can access the private repository, then download the newest agent release, check it and install it:

```sh
gh auth login
tag=$(gh release list --repo Aquitano/aqt --json tagName --jq '[.[].tagName | select(startswith("turnstash/v"))][0]')
cd "$(mktemp -d)"
gh release download "$tag" --repo Aquitano/aqt --pattern turnstash.js --pattern turnstash.tgz --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
mkdir -p "$HOME/.local/bin"
install -m 755 turnstash.js "$HOME/.local/bin/turnstash"
export PATH="$HOME/.local/bin:$PATH"
turnstash --help
```

Keep `~/.local/bin` and Bun on your shell's `PATH`. To upgrade, run the same commands again; the schedule keeps using the installed path. On Windows, keep the downloaded `turnstash.js` in a fixed place and run it with `bun <path>/turnstash.js` in place of `turnstash` in the commands below.

To run an unreleased change, build the agent from a checkout instead: `gh repo clone Aquitano/aqt`, then in `aqt/apps/turnstash` run `bun install --frozen-lockfile` and `bun run --cwd apps/agent build`, and install `apps/agent/dist/turnstash.js` the same way.

With authentik enabled, sign in to the dashboard and open **Settings > Machines > Enrol machine**. Choose the machine name, operating system, and architecture. Run the generated `turnstash connect` command on that machine, then run `turnstash sync` and `turnstash status`. The UI shows the machine token once. Each machine has its own token and does not need an authentik browser session to sync.

When the server uses token authentication, you can also enroll directly with its admin token:

```sh
printf 'Admin token: '
read -r -s turnstash_admin_token
printf '\n'
turnstash enroll --server https://turnstash.example.com --admin-token "$turnstash_admin_token" --name laptop
unset turnstash_admin_token
turnstash sync
turnstash status
```

Replace the example URL with your server's HTTPS URL and choose a different name for each machine. Open the dashboard and confirm that the first sync's conversations appear. Then install automatic sync:

```sh
turnstash schedule install --every 15m
```

On a Linux machine that must sync after logout, enable its user services with `sudo loginctl enable-linger "$USER"`. Keep Bun and the installed agent at their current paths, or reinstall the schedule after moving them.

If you create a machine in Settings, run the generated `turnstash connect --server <url> --machine-id <id> --token <machine-token>` command instead of `enroll`. This saves that machine's credentials without creating another machine.

An existing agent connection cannot be replaced with a different machine or server because its sync checkpoints and queued batches belong to that connection. To use a second server, set both `TURNSTASH_CONFIG_DIR` and `TURNSTASH_STATE_DIR` to separate directories before enrolling. `connect` can refresh the token for the same server and machine.

To distribute the agent as a package, run `bun pm --cwd apps/agent pack`. Packing builds the bundle automatically. After a version has been published to the configured registry, install it with `bun add -g --registry https://npm.aquitano.me @aqt/turnstash`. The turnstash workflow does not publish the agent package.

`enroll` writes `~/.config/aqt-turnstash/config.json` (mode 0600) with the machine token. `sync` scans every provider root, extracts new records, redacts them, queues them in `~/.local/state/aqt-turnstash/agent.db` and pushes batches of at most 500 records or 8 MB with idempotent batch ids. `schedule install` writes a launchd agent, a systemd user timer or a Task Scheduler job. `doctor` lists the discovered roots and checks the server, `status` shows the outbox.

Environment overrides: `TURNSTASH_CONFIG_DIR`, `TURNSTASH_STATE_DIR`, plus the provider specific ones (`CLAUDE_CONFIG_DIR`, `CLAUDE_CONFIG_DIRS`, `TURNSTASH_DESKTOP_SESSIONS_DIR`, `CODEX_HOME`, `OPENCODE_DATA_DIR`, `OPENCODE_DB_PREFIX`, `TURNSTASH_CURSOR_DB`, `TURNSTASH_COPILOT_SESSION_STATE_DIR`, `TURNSTASH_COPILOT_SESSION_STORE_DB`, `TURNSTASH_COPILOT_GLOBAL_STORAGE_DIR`, `TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR`, `GEMINI_SESSIONS_DIR`, `GEMINI_DIR`, `PI_SESSIONS_DIR`, `OMP_SESSIONS_DIR`, `ANTIGRAVITY_DATA_DIR`).

Copilot collection includes retained CLI journals in `~/.copilot/session-state`, both `<session-id>.jsonl` and `<session-id>/events.jsonl`, and saved VS Code chats in `User/workspaceStorage/*/chatSessions`. Code, Code - Insiders, and VSCodium are scanned in the OS application-data directory. Set `TURNSTASH_COPILOT_WORKSPACE_STORAGE_DIR` to scan a custom workspace-storage directory. Both JSON snapshots and JSONL update journals are supported without starting VS Code.

Saved VS Code chats retain user messages, assistant text, thinking, tool invocation summaries, model identifiers, and workspace URIs. Editor snapshots and rendered prompt context are omitted. Empty sessions and chats from other extensions produce no conversations. Saved VS Code chats do not supply token counts, so they produce no billable model requests.

`schedule install` saves the current config, state, and provider path overrides and `PATH` in a private runner beside the agent config. Reinstall the schedule after changing those overrides or moving the installed agent. On Linux, the systemd user timer runs while your user manager is active. Enable lingering for your user if it must run after logout.

### Read the archive

The read commands query the server's archive from any terminal, across every machine. They need an API token with the read scope from **Settings > Tokens**; the machine token that `sync` uses cannot read. They never open the agent's state database or write its config, so they also work where the collector cannot, such as a sandbox with a read-only home directory.

```sh
printf 'Read token: '
read -r -s TURNSTASH_READ_TOKEN
printf '\n'
export TURNSTASH_READ_TOKEN
turnstash sessions list --limit 50
turnstash sessions show <id>
turnstash sessions messages <id> --limit 100
turnstash sessions export <id> --tools > session.md
turnstash search "pricing catalog" --role user
turnstash stats --from 2026-09-01
turnstash analysis --provider codex
```

The server URL comes from `--server`, then `TURNSTASH_SERVER`, then the enrolled config, and `--token` overrides `TURNSTASH_READ_TOKEN`. `sessions list`, `stats` and `analysis` filter by `--provider`, `--machine` (name or id), `--project`, `--from` and `--to`. The date flags take a UTC date or a UTC timestamp such as `2026-10-01T08:00:00Z`, and a date-only `--to` includes that day. The daily totals in `stats` follow this machine's time zone, as the web UI follows the browser's. Sessions are listed by start time, newest first, with the id breaking ties. Subagent sessions are included and marked `↳`, and carry a `parentId` in JSON. A page holds 50 sessions unless `--limit` asks for up to 500; repeat the command with the printed `--cursor` for the next one. Every command takes `--json` to print the server's response unchanged, for scripts and agents.

### Upgrade a Codeburn agent

Before replacing the old executable, run `codeburn schedule uninstall`. Keep the existing config and SQLite state together by setting `TURNSTASH_CONFIG_DIR` and `TURNSTASH_STATE_DIR` to their existing directories. On Linux and macOS, the old defaults are `~/.config/aqt-codeburn` and `~/.local/state/aqt-codeburn`, unless you changed the XDG directories. Replace any `CODEBURN_` environment variable prefix with `TURNSTASH_`, including provider overrides. Run `turnstash status` and confirm the existing enrollment, then run `turnstash sync` and reinstall the schedule. The new schedule uses the Turnstash name and saves those directory overrides. The rename does not move or delete existing data.

## Development

Turnstash is part of the aqt workspace. From the repository root:

```sh
bun install
mise run turnstash:db     # dev database on 5437, disposable test database on 5434
mise run turnstash:check  # lint, format, typecheck and every test
mise run turnstash:dev    # server on 4320 with ADMIN_TOKEN=dev, web UI with hot reload
```

Without mise, run the commands those tasks list in `tools/tasks/turnstash.toml`.
Web, API-schema, and analysis tests use Vitest; `vite.config.ts` lists them and
`bunfig.toml` excludes them from Bun. Bun runs every other test, because that code
uses Bun APIs. `bun run test` from this directory runs both runners;
`bunx --no-install vp test run` runs only Vitest.

The server tests in `apps/server/test` truncate the separate, disposable `turnstash_test` database on port 5434. They ignore `DATABASE_URL`. Override `TEST_DATABASE_URL` only with a test database whose name ends in `_test`; the test helper rejects other names before migrations or truncation. Provider tests use anonymized fixtures under `packages/providers/test/fixtures`. Regenerate migrations with `bun run --cwd apps/server db:generate` after changing `apps/server/src/db/schema.ts`.

## Deleting a conversation

`DELETE /api/conversations/:id` purges the conversation, its messages, tool output, requests and raw records, and writes a tombstone. Agents download tombstones on every sync and skip those conversations; the server also refuses to re-ingest them. Deleting the source log on a machine never deletes the archived conversation.
