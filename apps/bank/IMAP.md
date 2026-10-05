# Collect mail over IMAP

`bank imap` runs a foreground daemon that polls selected mailboxes and uploads
complete messages to `bank serve`. It works independently of Betterbird and
does not require a local Postgres database. The existing Gmail API `bank sync`
command remains available.

The collector uses read-only `EXAMINE` and `BODY.PEEK[]`. It does not mark mail
as read, move messages, delete messages, or copy mailbox deletions into Bank.
The first run imports the existing contents of every selected folder.

Each upload includes its account ID and exact IMAP folder. Bank stores historical folder observations, including duplicates already seen elsewhere. Upgrade the Bank server before this collector: a response without `mail_context_version: 1` keeps the queued file pending and does not advance its checkpoint. See [MAIL.md](MAIL.md) for folder filters and recovery.

## Start with Proton Bridge on Windows

Run these commands from `apps/bank` after building `bank.exe`:

```powershell
go build -o .build/bank.exe ./cmd/bank
$imapDir = Join-Path $env:LOCALAPPDATA 'aqt-bank\imap'
New-Item -ItemType Directory -Force $imapDir
Copy-Item .\imap.example.json (Join-Path $imapDir 'config.json')
```

Edit the copied configuration before running the collector:

1. Copy the IMAP address, port and connection mode from Bridge's account
   settings. Use `"tls": "starttls"` for STARTTLS or `"tls": "tls"` for SSL/TLS.
   The example port is not necessarily the port on your machine.
2. In Bridge's advanced settings, use **Export TLS certificates**. Put the
   exported public certificate in `bridge-cert.pem` beside `config.json`.
   The collector does not need the exported private key. Certificate verification
   stays enabled. If the certificate names `localhost` rather than `127.0.0.1`,
   set `"tls_server_name": "localhost"` to match its identity.
3. Select folders explicitly. For a small trial, create a dedicated folder
   containing a few messages. Selecting `INBOX` imports its entire history.
   Folder names must match IMAP
   names, including any parent folder. `--check` lists the names the server uses.

Bridge generates credentials for IMAP. Use those credentials, not your Proton
account password. Bridge must be running on the same machine as the collector.
See [Bridge settings](https://proton.me/support/comprehensive-guide-to-bridge-settings)
and [Proton's client setup guide](https://proton.me/support/protonmail-bridge-clients-windows-thunderbird).

Set credentials in the process environment. PowerShell 7 can prompt for secrets
without putting them in shell history:

```powershell
$env:BANK_PROTON_USER = Read-Host 'Bridge IMAP username'
$env:BANK_PROTON_PASSWORD = Read-Host 'Bridge IMAP password' -MaskInput
.\.build\bank.exe imap --config "$imapDir\config.json" --check
```

`--check` authenticates, lists folders and opens selected folders read-only. It
does not download message bodies, create checkpoints or contact Bank. If a
selected folder does not exist, it prints the available folders and exits with
an error. Edit the selection and run it again.

To import, supply the existing Bank URL and token:

```powershell
$env:BANK_URL = Read-Host 'Bank URL'
$env:BANK_TOKEN = Read-Host 'Bank token' -MaskInput
.\.build\bank.exe imap --config "$imapDir\config.json" --once
.\.build\bank.exe imap --config "$imapDir\config.json" --status
```

`--once` performs one pass over every configured account and exits nonzero if
any account or folder fails. A second successful run with no new messages
downloads no bodies. Review the import results before starting continuous mode:

```powershell
.\.build\bank.exe imap --config "$imapDir\config.json"
```

Ctrl+C stops the collector and interrupts active connections and uploads. An
interrupted batch is retried on the next run. Use HTTPS for `BANK_URL`, or the
existing HTTP Bank endpoint over its private Tailscale connection.

## Add Gmail IMAP

Add this account to the `accounts` array:

```json
{
  "id": "gmail-personal",
  "source": "gmail",
  "address": "imap.gmail.com:993",
  "username_env": "BANK_GMAIL_USER",
  "password_env": "BANK_GMAIL_APP_PASSWORD",
  "tls": "tls",
  "folders": ["INBOX"]
}
```

Use the complete Gmail address as the username and a Google app password as the
password. App passwords require 2-Step Verification and are not available for
every account or organization policy. See [Google's app password instructions](https://support.google.com/mail/answer/185833).
Run `--check` to discover the actual Sent and All Mail names; they can be localized.

For Google OAuth, remove `password_env` and add:

```json
"oauth2": {
  "client_id_env": "BANK_GMAIL_CLIENT_ID",
  "client_secret_env": "BANK_GMAIL_CLIENT_SECRET",
  "refresh_token_env": "BANK_GMAIL_REFRESH_TOKEN"
}
```

Supply an existing Google OAuth client and refresh token authorized for the
`https://mail.google.com/` scope. The collector refreshes access tokens and
authenticates with XOAUTH2. This command does not run the initial browser consent
flow. Tokens from Bank's existing `bank auth gmail` use `gmail.readonly` and are
not sufficient for IMAP. See [Google's IMAP OAuth documentation](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).

Keep `source` as `gmail` when trying IMAP alongside existing Gmail API imports.
Bank deduplicates messages with the same Message-ID within a source. After the
trial, use one collector per mailbox to avoid repeated downloads. API and IMAP
collection keep independent checkpoints. Messages without Message-ID use their
raw content digest for EML deduplication; do not assume cross-provider or
cross-source deduplication.

## Configuration

Paths are relative to the configuration file. Credentials are read only from
the named environment variables and are never written to the checkpoint database.
Unknown JSON fields are rejected. Restart after changing configuration,
credentials or Bridge's certificate.

Separate accounts require distinct `source` values. Duplicate sources in one configuration are rejected before connecting. If an older configuration combined accounts under one source, choose explicit sources for future imports. Existing messages are not renamed or split automatically. Keep an existing Gmail API source only when the IMAP account represents that same mailbox.

| Field                        | Default          | Behavior                                                                                            |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `state_dir`                  | `imap-state`     | Collector-owned directory for SQLite state, its lock and pending message files. Use a local disk.   |
| `interval`                   | `1m`             | Delay after a successful account pass.                                                              |
| `timeout`                    | `2m`             | Limit per connection/authentication operation, IMAP command or upload. Increase for slow backfills. |
| `workers`                    | `4`              | Maximum simultaneous Bank uploads per account, from 1 to 16.                                        |
| `batch_size`                 | `32`             | Maximum messages per body fetch, from 1 to 256.                                                     |
| `max_message_bytes`          | `67108864`       | Maximum raw email size, including attachments. Up to 512 MiB.                                       |
| `accounts[].id`              | Required         | Stable unique name for local checkpoints.                                                           |
| `accounts[].source`          | Required         | Bank source name, such as `proton` or `gmail`.                                                      |
| `accounts[].folders`         | Required         | Exact folder names to collect. No implicit all-folder selection.                                    |
| `accounts[].tls_ca_file`     | System trust     | Additional PEM certificates, typically Bridge's self-signed certificate.                            |
| `accounts[].tls_server_name` | Address hostname | Certificate identity to verify.                                                                     |

Both `tls` and `starttls` require certificate verification and TLS 1.2 or newer.
There is no plaintext mode or option to disable certificate verification.

Choose either All Mail or a set of individual folders where possible. The same
message can appear in several IMAP folders; Bank deduplicates it after upload,
but reading every copy still costs bandwidth. Adding a folder backfills it.
Removing a folder stops future collection without deleting archived messages.
If that folder has pending uploads, they remain on disk until the folder is
enabled again.

## Recovery and operation

Each account polls independently. Failures retry with exponential backoff and
jitter, starting at 5 seconds and capped at 5 minutes. A broken folder does not
prevent other folders from being collected. Connection failures end that
account's current pass. Other accounts continue.

The collector fetches metadata in bounded UID windows and bodies in batches of
at most 16 MiB, except that one allowed larger message occupies its own batch.
Bodies stream to files rather than accumulating in memory. Completed downloads
are flushed to disk before publication. On POSIX, the collector syncs the batch
directory and its parent. On Windows, it publishes files and the batch directory
with write-through moves. Only then does it commit the persistent upload queue.
These barriers depend on the filesystem and storage device honoring flushes;
the tests do not simulate physical power loss. Uploads run
concurrently. A folder's queued batch is uploaded before reconnecting to IMAP,
so it can survive a restart or deletion from the mailbox while Bank is offline.
Files are removed only after acknowledgement. A batch that fails to stage is
removed at once. Abandoned `fetch-*` directories without queue references, such
as those left by a crash, are removed on the next start under the state lock.
The queue contains decrypted mail, so keep the state directory private.

SQLite checkpoints use `(account, folder, UIDVALIDITY, UID)`. A batch advances
only when every message receives a successful Bank import acknowledgement.
If an upload succeeds but its response is lost, the batch is retried and Bank
deduplicates it. UIDVALIDITY changes cause that folder to be scanned again.
Messages deleted from the mail server before collection cannot be recovered.

Metadata scans use UIDs. Body fetches use the observed sequence numbers and
verify every returned UID before staging the batch. This supports servers that
send the body before its UID. If a deletion changes the sequence mapping between
commands, the batch fails without advancing its checkpoint and retries with
fresh metadata.

A message whose body exceeds `max_message_bytes` stops its folder and records an
error. Increase the configured size limit, then retry. The size the server
reports in metadata only groups messages into batches, so an inaccurate report
does not block a message. A message Bank cannot parse is acknowledged as
rejected and the checkpoint moves past it, because Bank has already archived its
raw bytes and folder context. The collector records its UID, counts it as
`rejected` in `checkpoint` and `pass` events and in `--status`, and Bank logs the
parse error. An import that fails for any other reason stops its folder until a
retry succeeds. A message that disappears during
FETCH is retried on the next pass, whose metadata query sees the current mailbox.

Each committed batch prints a `checkpoint` JSON event with its folder, UID and
cumulative counts for the current account pass. A completed pass prints a
`pass` event with totals and any error/retry delay. `--status` reads the local database without
connecting to IMAP or Bank. It reports the last attempt, last fully successful
pass, pending upload count and latest error. During a long initial backfill, the last success remains
empty until all configured folders complete.

Only one daemon can use a state directory. Changing an existing account's
address, username, source or Bank URL is rejected to prevent old checkpoints
from skipping a different mailbox or destination. Use a new account ID for an
intentional fresh scan. After restoring Bank from an older backup, use a new
state directory to replay mail still available on the server.

To start automatically on Windows, register the command in Task Scheduler under
your user account after the manual trial. Use an at-logon trigger, prevent
overlapping instances, disable the execution time limit, and enable restart on
failure. Supply the same credentials to that process; variables set only in an
interactive PowerShell window are not available to a separately launched task.
Keep logs outside the repository. Bridge and the collector must both be running.
No scheduled task or service is installed by the build.

On an always-on Linux machine, run the same foreground command under systemd
with `Restart=on-failure`, a persistent state directory and credentials supplied
to the process. Do not expose Bridge's IMAP listener to the network; run the
collector beside Bridge and upload through Bank's HTTP API.

## Development checks

```sh
go test ./internal/imapsync -count=1
go test -race ./internal/imapsync
go test ./internal/imapsync -run '^$' -bench BenchmarkIMAPBackfill -benchmem
go vet ./...
```

The integration tests run local TLS/STARTTLS IMAP servers and an HTTP import
receiver. They cover raw messages and attachments, lost acknowledgements,
restart recovery, UIDVALIDITY changes, read-only access, rejected imports,
oversized messages, certificate trust, XOAUTH2 success/error responses, process
locking, queued mail surviving mailbox deletion, independent account retries,
polling, mid-body cancellation and timeouts, body-before-UID responses, changed
sequence mappings and failed batch publication. They do not contact Proton, Gmail or a live
Bank server. The benchmark measures local IMAP fetch, staging and checkpoints
with an acknowledging importer, not remote Bank/database throughput.
