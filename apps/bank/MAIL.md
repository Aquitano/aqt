# Import and recover mail metadata

Bank keeps folder observations separately from message identity. Importing one email from two folders produces one canonical message and two memberships. Folder observations are historical, not a live view of moves or deletions.

## Preserve export folders

Use an explicit layout for a directory import:

```sh
bank import mail-tree --source proton --layout eml ./export
bank import mail-tree --source proton --layout thunderbird ./Mail/LocalFolders
```

The EML layout reads `.eml` files and uses each file's relative parent as its mailbox. Files at the root use `.`. The Thunderbird layout reads extensionless MBOX files and descends through `.sbd` directories. `Work.sbd/Receipts` becomes mailbox `Work/Receipts`. Index files, symlinks, and unsupported entries are skipped with a reason.

To assign a folder to a single file:

```sh
bank import eml --source proton --mailbox 'Work!' ./message.eml
bank import mbox --source gmail --mailbox Archive ./archive.mbox
```

Existing imports without `--mailbox` still work, but do not invent folder membership. Folder identity includes the source, import kind, and exact path. `Work!`, `Work`, and `work` stay distinct. Export and IMAP folders stay distinct. Only IMAP's case-insensitive `INBOX` receives canonical spelling.

With `BANK_URL` set, the CLI uploads each file with the same context used by local imports. Upgrade the receiving Bank server before the collector. A contextual upload requires its own context version in the successful response's `mail_context_version`. Version 2 adds a provider thread ID and further IMAP folders, which the IMAP collector sends for Gmail threads and labels. A response from an older server leaves IMAP mail queued for retry.

## Find mail

```sh
bank mail mailboxes --source proton --json
bank search --source proton --mailbox-id 12 --subject invoice --has-attachment true
bank search retainer --source proton --mailbox-id 12 --has-attachment false
```

Use a mailbox ID returned by the first command, not the example ID. A mailbox ID requires its source. `--subject` matches a case-insensitive literal substring. Attachment presence counts stored attachment rows, regardless of extraction status.

With query text, search returns ranked messages. Without query text, it returns matching conversation summaries ordered newest first. Summary counts and dates describe only matching messages. Opening a conversation reads its complete history, not just the filtered subset. The browser exposes these filters and labels folder badges as historical observations.

## Read reconstructed conversations

Bank joins email using bounded `References` and `In-Reply-To` evidence. Subject similarity alone never joins messages. Missing ancestors are retained as placeholders so later arrivals can complete the conversation. The projection preserves message refs, external IDs, bodies, raw references, and attachment rows.

A component with one explicit provider thread ID uses that ID. For Gmail this is the API's hexadecimal `threadId`; the decimal `X-GM-THRID` from a Takeout header or from IMAP is converted to it. Without one, Bank derives an ID beginning with `mail:`. Only an mbox import, the form Takeout exports, reads the `X-GM-THRID` header; in EML and collected mail the sender chose it, so Bank ignores it. Earlier derived IDs resolve through aliases if later mail changes the grouping.

When contradictory headers connect multiple provider threads, Bank preserves each provider's thread and leaves unanchored messages separate. Opening an old combined thread returns a typed conflict instead of silently choosing one provider. The browser offers provider choices and a paginated list of unanchored messages. The CLI error includes the commands to read both:

```sh
bank thread '<current-thread-id>' --current --source gmail
bank mail conflict '<conflict-key>' --source gmail --limit 100
bank mail conflict '<conflict-key>' --source gmail --before 123 --limit 100
```

## Inspect message provenance

Open **Message provenance** beneath a message in the browser, or run:

```sh
bank show <id-or-ref> --provenance
bank show <id-or-ref> --json
```

The view includes the source, stable ref, external ID, original archived input, and historically observed folders. For mail, it also shows the normalized Message-ID, reply headers, provider thread ID, grouping conflicts, and incomplete grouping. A reply connection can come from another message's headers. Missing folder observations do not mean the message was never in a folder.

The header archive input identifies the file used for the current stored headers. It can differ from the original archived input after a duplicate import corrects the headers. Older metadata may have no recorded header input. Archive paths are relative to the server archive directory. The JSON message detail and conversation responses include the same mail evidence under `mail`.

## Rebuild metadata

Run rebuild beside the database and archive. It is not available through `BANK_URL`. Back up the database, raw archive, and blobs before applying historical changes.

```sh
bank mail rebuild --source proton
bank mail rebuild --source proton --apply
bank verify --source proton --json
```

The first command is read-only, including its database connection. It does not migrate the schema, create context files, or write checkpoints. Run a current Bank server first if the database has not received the additive mail migrations. The preview carries earlier proposed graph changes in memory, so conflicts across archived inputs are visible before applying. It stops rather than presenting a complete preview when grouping is incomplete. When its workspace exceeds 100000 nodes or messages, or 1000000 edge and historical references, it discards the proposals held so far and compares later inputs against the database alone. The report counts these discards as `preview_resets`. A non-zero count means a conflict between inputs on either side of a reset can surface only in the applied run.

Rebuild reads archived EML headers without loading message bodies and streams MBOX. The MBOX import size limit does not apply to individual EML inputs. It resolves existing canonical rows and updates only mail metadata and thread projections. It does not create messages, rewrite bodies, or extract attachments. JSON output reports missing rows, unknown folders, invalid inputs, conflicts, and incomplete grouping.

Applied work is checkpointed in the destination database with the context identity, raw digest, projection version, and grouping limits. A newly archived context is new work even if its raw file was processed before. Failed or incomplete work is retryable. Repeating an interrupted MBOX rebuild safely replays any uncheckpointed messages.

The grouping limits apply to the connected header component. The node limit also bounds the total node references in affected historical alias records:

| Environment variable     | Default |
| ------------------------ | ------: |
| `BANK_MAIL_MAX_NODES`    |   10000 |
| `BANK_MAIL_MAX_EDGES`    |   50000 |
| `BANK_MAIL_MAX_MESSAGES` |   10000 |

Each limit accepts 1 through 100000. Exceeding a limit retains header facts and explicit provider IDs but avoids additional inferred merges. Existing edges stay available until a complete recomputation can process a correction. The import report warns about incomplete grouping. Raise a limit deliberately and run rebuild to retry.

After a split, `--current` reads a subgroup listed in the conflict response without following its historical alias. Without that flag, the old combined ID continues to describe the split. The browser follows aliases for search and browse results, then uses current subgroup reads when a subgroup is chosen in the conflict picker.

Rebuild preserves headers and provider IDs already recorded in the database, so older archive inputs cannot undo a correction. It still recovers folder observations from every input, and a message without a provider ID takes the Gmail thread ID from the `X-GM-THRID` header of an archived mbox. Keep the database backup: immutable context records do not record correction order, so raw inputs alone cannot identify which variant was the last correction.

## Recover folder provenance

Mail imports write immutable digest-named JSON records under `archive/<source>/.mail-contexts/` before the database projection. Records contain the raw reference, input kind, folder context, and any supplied external ID, provider thread ID, or date override. They contain no account credentials. After a crash, rebuild can recover folder observations and missing metadata for existing messages. If a duplicate header or provider correction was archived but never projected, reimport that corrected input or resync the provider: rebuild preserves the facts already in the database. `bank verify` checks context digests, validation, and raw references.

Backups must include these hidden directories. Old raw files without context have unknown folders. Recover that information from the original export tree, not flattened archive filenames. Historical Gmail raw files may lack provider IDs that existed only in the database. Keep a database backup or resync Gmail; raw bytes cannot reproduce metadata that was never captured.

HTML rendering and browser uploads are not part of this workflow. The reader continues to display normalized message text.
