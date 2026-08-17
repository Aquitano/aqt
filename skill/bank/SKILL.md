---
name: bank
description: Search the owner's personal message archive (aqt-bank) through the `bank` CLI. Use whenever a task needs something he wrote, received or was sent — an old email thread (Gmail, Proton), a WhatsApp or Discord conversation, a LinkedIn message, a past ChatGPT/Claude/Claude Code session, a decision or a name or a number that was discussed somewhere — or when you need the bytes of an attachment that was mentioned in one of those. Also covers writing into it: archiving a note, a decision record or arbitrary messages via `bank import json`. Trigger on requests like "what did X say about Y", "find that email/chat about Z", "when did we agree on W", "pull the attachment from that message", "save this note to the archive".
---

# bank — the owner's message archive

One Postgres holding every message from every source, BM25-searchable from the CLI. Read freely, write rarely.

## Preflight

Run once before the first archive command in a session:

```sh
command -v bank
printenv BANK_URL BANK_TOKEN
bank stats
```

`bank stats` is the cheapest end-to-end check — if it prints a source table, everything works. Distinct failure modes, all of which mean stop and report rather than retry:

- `command -v bank` prints nothing — the binary is not installed on this machine. Report that; do not try to build or download it.
- `bank: migrate: failed to connect to ...: connection refused` — no `BANK_URL`, so the CLI fell back to a local Postgres that is not there. On a client machine that means `BANK_URL`/`BANK_TOKEN` are not exported into this shell; ask the owner to set them (see `skill/README.md` in the aqt-bank repo).
- `bank: GET /v1/stats: invalid or missing bearer token` — HTTP 401. `BANK_TOKEN` is unset, wrong or revoked. The owner has to run `bank token new <machine-name>` on the server and re-export the printed value; it is shown once.
- `dial tcp ...: connect: connection refused`, or a hang ending in an i/o timeout — the server is down or Tailscale is disconnected. Report; retrying will not help.

On the VPS itself there is no `BANK_URL`; `DATABASE_URL` points at Postgres and the same commands work locally.

## Reading

```sh
bank search "query" [--source s] [--from name] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--fuzzy 0-2] [--limit n] [--json]
bank show <id> [--json]          # full body, recipients, raw_ref, attachment list
bank stats [--json]              # sources, message counts, date ranges
bank fetch <sha256> -o <path>    # write attachment bytes to a file
```

Semantics that matter:

- Always pass `--json` when you are consuming the output; the plain text form truncates bodies to one line. `search --json` prints `null`, not `[]`, when nothing matched.
- Ranking is BM25 over subject, body and sender, with typo tolerance (`--fuzzy 1` by default, max 2). Query words are matched independently — more words means more recall, not less.
- `--from` is a case-insensitive substring of the sender field, so `--from alice` matches `Alice Example` and `alice@example.com`.
- `--until` is exclusive; both dates are plain `YYYY-MM-DD`.
- `--limit` defaults to 20. Start generous (50-100), then narrow with `--source`/`--from`/dates rather than re-running blind.
- `search` returns bodies already, so only `bank show <id>` when you need recipients, `external_id`, `raw_ref` or attachments.

Worked examples:

```sh
# "what did Alice say about the invoice back then"
bank search "invoice" --from alice --since 2024-01-01 --json

# "did I ever discuss pgvector with ChatGPT"
bank search "pgvector" --source chatgpt --limit 50 --json

# typo in the name, or in the archived text: widen the distance
bank search "hetzner invoise" --fuzzy 2 --limit 5

# grab the screenshot attached to a message
bank show 4 --json          # -> attachments[].sha256
bank fetch 407b467e378d279e4d2ed7d8418f12d6937e00f4d8b7d0310c12470883b0431d -o /tmp/screenshot.jpg

# what is even in here, and how far back
bank stats --json
```

## Sources

`whatsapp`, `gmail`, `proton`, `discord`, `linkedin`, `chatgpt`, `claude` (claude.ai exports), `claude-code` (session transcripts), plus any name created by a past `bank import json --source <name>`. Run `bank stats` to see which actually exist here before filtering on one — a `--source` typo silently returns nothing.

## Writing

This is the owner's archive; writes are for things worth keeping, not for scratch state.

```sh
echo '{"body":"note text","thread":"decisions","sender":"claude","sent_at":"2026-08-17T12:00:00Z"}' \
  | bank import json --source agent-notes -
```

Input is a JSON array, a single object, or NDJSON, on stdin (`-`) or a file path. Fields: `body` required (`subject` alone also passes); `thread`, `sender`, `recipients`, `subject`, `sent_at`, `external_id`, `attachments[].path` optional. `sent_at` takes RFC 3339, `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` or unix seconds, and defaults to import time.

Dedup is stable: with no `external_id`, the id is a hash of source, thread, `sent_at`, sender, subject and body, so re-importing an identical entry is a no-op — `json: 0 new, 1 already known`. Entries without `sent_at` hash to import-time-independent ids too, so re-running a file is safe.

Rules:

- Do not invent a source name. Check `bank stats` and reuse the existing agent-notes-style source if one is there; only create a new one when the owner asks.
- Set an explicit `sent_at` for anything that describes a moment other than now.
- Every import is a write to the shared archive — say what you are about to store before storing it.
- `attachments[].path` only works for local imports (the file is read into the blob store on this machine). Over `BANK_URL` any entry carrying attachments is rejected whole — `1 entries rejected`, nothing inserted — so strip attachments before remote imports, or run the import on the server.

## Cautions

- `bank fetch` writes a file to disk; pick an explicit `-o` under a temp dir, and remember the bytes are personal data.
- Message bodies are private correspondence. Read what the task needs, quote the minimum, and do not paste whole threads into summaries or commit messages.
- `sync`, `auth`, `serve` and `token` are server-side commands. Do not run them from a client machine.
