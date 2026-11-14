# Import mail and read its conversations

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

`--source` and `--mailbox` are the options of the `eml` and `mbox` kinds, stored with each raw input. With `BANK_URL` set, the CLI uploads each file with the same options used by local imports. The IMAP collector sends further options for collected mail: the IMAP folder, Gmail labels and the provider thread ID.

## Find mail

```sh
bank mail mailboxes --source proton --json
bank search --source proton --mailbox-id 12 --subject invoice --has-attachment true
bank search retainer --source proton --mailbox-id 12 --has-attachment false
```

Use a mailbox ID returned by the first command, not the example ID. A mailbox ID requires its source. `--subject` matches a case-insensitive literal substring. Attachment presence counts stored attachment rows, regardless of extraction status.

With query text, search returns ranked messages. Without query text, it returns matching conversation summaries ordered newest first. Summary counts and dates describe only matching messages. Opening a conversation reads its complete history, not just the filtered subset. The browser exposes these filters and labels folder badges as historical observations.

## Read reconstructed conversations

Mail from Gmail keeps the thread Gmail gave it: the API's hexadecimal `threadId`, or the decimal `X-GM-THRID` from a Takeout mbox or from IMAP, converted to the same form. Only an mbox imported into the `gmail` source, which is where `bank import mbox` puts Takeout by default, reads the `X-GM-THRID` header; in EML, other sources' mailboxes and collected mail the sender chose it, so Bank ignores it.

Other mail is grouped by its `Message-ID`, `In-Reply-To` and `References` headers. A new mail joins every thread of its source that shares one of those ids with it, so two replies to a message Bank never received still land together. When one mail links two threads that were separate so far, they become one thread under the smaller id, and the other id stops existing. The result does not depend on the order mail arrives in. Subject similarity alone never joins messages.

A thread's id starts with `mail:` and comes from the first message the conversation names, so it is usually the same whichever of its mails was imported first.

## Inspect message provenance

Open **Message provenance** beneath a message in the browser, or run:

```sh
bank show <id-or-ref> --provenance
bank show <id-or-ref> --json
```

The view includes the source, stable ref, external ID, raw input and the message's place in it, and historically observed folders. For mail, it also shows the normalized Message-ID, the reply headers, and whether the thread came from the provider. Missing folder observations do not mean the message was never in a folder. The JSON message detail and conversation responses include the same mail evidence under `mail`.

HTML rendering and browser uploads are not part of this workflow. The reader continues to display normalized message text.
