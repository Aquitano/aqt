// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"
	// Embedded so a container without tzdata still resolves the local zone.
	// Dates typed as YYYY-MM-DD and WhatsApp export timestamps are read in
	// local time, so an image that silently fell back to UTC would shift them.
	_ "time/tzdata"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/gmail"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/verify"
	"github.com/aquitano/aqt/apps/bank/internal/webui"
)

const usage = `bank — personal message archive

Usage:
  bank auth gmail [--port n] [--bind addr]    authorize Gmail (loopback OAuth)
  bank sync [--full]                          pull new mail from Gmail
  bank imap --config <file> [--once]         collect IMAP mail continuously or once
  bank imap --config <file> --check          check IMAP login and selected folders
  bank imap --config <file> --status         read local IMAP collector status
  bank import whatsapp <export.zip|.txt>...   WhatsApp "Export chat" files
  bank import eml [--source s] <file|dir>...  .eml files (default source: proton)
  bank import mbox [--source s] <file>...     mbox files (default source: gmail)
  bank import eml|mbox --mailbox <name> <file>  preserve a folder observation
  bank import mail-tree --source s --layout eml|thunderbird <root>
  bank mail mailboxes --source s [--json]    list historically observed folders
  bank mail rebuild --source s [--apply]    rebuild mail metadata (dry run by default)
  bank mail conflict <key> --source s       page unanchored mail after a thread split
  bank import discord <package.zip|dir>...    Discord GDPR data package
  bank import linkedin <zip|csv|dir>...       LinkedIn data export
  bank import youtube <takeout.zip|dir|json>  YouTube watch history (Google Takeout)
  bank import chatgpt <export.zip|json|dir>   ChatGPT data export
  bank import claude <export.zip|json|dir>    Claude.ai data export
  bank import json [--source s] <file|->      arbitrary JSON/NDJSON messages
                                              (the escape hatch for agents; - reads stdin)
  bank import inbox [--json]                  sweep $BANK_DATA_DIR/inbox/<kind>/
  bank import ... [--no-extract]              skip reading text out of attachments
  bank reimport <source>                      replay archived inputs through the current importer
  bank reimport mbox --heal-bodies [--apply]  re-read archived mail and replace stub bodies
                                              today's parser reads better (dry run by default)
  bank extract [--ocr] [--status s]           read text out of attachments
  bank attachment list [--status s]           attachment content and its text status
  bank reports [--before ID] [--json]         saved import outcomes and gaps
  bank attachment find [--filename invoice] [--text phrase] [--type pdf] [--person alice] [--json]
  bank attachment messages <sha256>          every message with this file, as JSON
  bank attachment stats [--json]              how much of the archive is searchable inside
  bank attachment text <sha256> [--set f]     read, replace or clear that text
  bank search [query] [flags]                 full-text search, or filtered conversations
  bank thread <id> [--source s] [--limit n]   one conversation page, oldest first
  bank contact <add|list|show|alias|...>      one person across their many identities
  bank show <id|ref> [--json] [--provenance]   print one message + attachments
  bank stats [--json]                         per-source counts, date ranges, freshness
  bank coverage <source> <text>               note what a source holds (empty text clears)
  bank query <sql|-> [--limit n] [--json]     read-only ad-hoc SQL (analytics escape
                                              hatch; READ ONLY tx, 15s timeout,
                                              row cap 100, --limit up to 10000)
  bank query --schema                         list tables and columns
  bank fetch <sha256> [-o path]               write an attachment to a file
  bank verify [--heal] [--source s] [--json]  check archive integrity, optionally repair
  bank serve [--listen addr]                  HTTP API (default 127.0.0.1:8480)
  bank ui [--listen addr] [--no-open]         local archive browser (default
                                              127.0.0.1:8481; needs BANK_URL)
  bank token new <name>                       mint an API token (printed once)
  bank token list                             token names
  bank token revoke <name>                    drop a token

Extraction flags (bank extract):
  --status s     work on this status (repeatable; default: content never tried)
                 pending, ok, empty, needs_ocr, unsupported, too_big, failed
                 (not manual: transcriptions are only replaced by
                  'bank attachment text --set' or cleared with --clear)
  --ocr          read images and text-layer-less PDFs (needs tesseract, poppler)
  --lang s       OCR language, tesseract syntax (default eng; "deu+eng" for two)
  --source s     only content carried by this source
  --limit n      stop after this many files
  --watch        keep draining the queue instead of running once
  --interval d   how often --watch runs (default 30m)

Search flags:
  --source s     filter by source (whatsapp, gmail, ...)
  --mailbox-id n  observed folder id from bank mail mailboxes; requires --source
  --subject text subject contains this literal text, case-insensitive
  --has-attachment true|false  filter by attachment presence
  --from name    filter by sender (substring, case-insensitive)
  --to name      filter by recipient (substring, case-insensitive)
  --person name  filter by contact, across all their aliases (bank contact)
  --since date   YYYY-MM-DD
  --until date   YYYY-MM-DD (exclusive)
  --match mode   any (default), all words, or phrase
  --fuzzy n      typo tolerance 0-2 (default 1; ignored for phrase)
  --limit n      max results, 1-500 (default 20)
  --offset n     skip this many ranked results, for the next page (max 10000)
  --json         JSON output

Thread flags:
  --current      read a current subgroup instead of resolving its historical alias
  --around id    center context on this message's numeric id
  --before id    page backward from this message
  --after id     page forward from this message
  --latest       start at the newest page
                 Choose one position; pages are always chronological.
  --limit n      page size, 1-2000 (default 2000)
  --json         includes has_before, has_after, and attachments

Environment:
  DATABASE_URL   default postgres://bank:bank@localhost:5433/bank
  BANK_DATA_DIR  default ~/.local/share/aqt-bank (blobs/, archive/, inbox/)
  BANK_URL       talk to a remote 'bank serve' instead of Postgres
  BANK_TOKEN     bearer token for BANK_URL (see 'bank token new')
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	ctx := context.Background()
	var err error
	switch os.Args[1] {
	case "auth":
		err = cmdAuth(ctx, os.Args[2:])
	case "sync":
		err = cmdSync(ctx, os.Args[2:])
	case "imap":
		err = cmdIMAP(ctx, os.Args[2:])
	case "mail":
		err = cmdMail(ctx, os.Args[2:])
	case "import":
		err = cmdImport(ctx, os.Args[2:])
	case "reimport":
		err = cmdReimport(ctx, os.Args[2:])
	case "search":
		err = cmdSearch(ctx, os.Args[2:])
	case "thread":
		err = cmdThread(ctx, os.Args[2:])
	case "contact":
		err = cmdContact(ctx, os.Args[2:])
	case "show":
		err = cmdShow(ctx, os.Args[2:])
	case "stats":
		err = cmdStats(ctx, os.Args[2:])
	case "coverage":
		err = cmdCoverage(ctx, os.Args[2:])
	case "query":
		err = cmdQuery(ctx, os.Args[2:])
	case "fetch":
		err = cmdFetch(ctx, os.Args[2:])
	case "extract":
		err = cmdExtract(ctx, os.Args[2:])
	case "reports":
		err = cmdReports(ctx, os.Args[2:])
	case "attachment":
		err = cmdAttachment(ctx, os.Args[2:])
	case "verify":
		err = cmdVerify(ctx, os.Args[2:])
	case "serve":
		err = cmdServe(ctx, os.Args[2:])
	case "ui":
		err = cmdUI(os.Args[2:])
	case "token":
		err = cmdToken(os.Args[2:])
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "bank:", err)
		os.Exit(1)
	}
}

func dataDir() string {
	if d := os.Getenv("BANK_DATA_DIR"); d != "" {
		return d
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "aqt-bank")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "aqt-bank-data"
	}
	return filepath.Join(home, ".local", "share", "aqt-bank")
}

func openStore(ctx context.Context) (*store.Store, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://bank:bank@localhost:5433/bank?sslmode=disable"
	}
	return store.Open(ctx, url)
}

// local is everything an importer needs when the CLI talks to Postgres
// directly rather than to a `bank serve`.
type local struct {
	st         *store.Store
	blobs      *blob.Store
	archiveDir string
}

func openLocal(ctx context.Context) (*local, func(), error) {
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	return &local{st: st, blobs: blobs, archiveDir: filepath.Join(dataDir(), "archive")}, st.Close, nil
}

func cmdAuth(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	port := fs.Int("port", 0, "")
	bind := fs.String("bind", "127.0.0.1", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 || fs.Arg(0) != "gmail" {
		return fmt.Errorf("usage: bank auth gmail [--port n] [--bind addr]")
	}
	return gmail.Authorize(ctx, dataDir(), *bind, *port)
}

func cmdSync(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	full := fs.Bool("full", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if client.FromEnv() != nil {
		return fmt.Errorf("sync reads the OAuth token beside the blob store and writes rows, blobs and raw mail together; run it on the server, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	res, err := gmail.Sync(ctx, d.st, d.blobs, dataDir(), d.archiveDir, *full)
	printSyncResult(res)
	return err
}

func printSyncResult(res gmail.SyncResult) {
	if res.Mode == "" {
		return
	}
	fmt.Printf("gmail (%s): %d new, %d already known, %d attachments", res.Mode, res.Inserted, res.Duplicates, res.Attachments)
	if res.Failed > 0 {
		fmt.Printf(", %d failed (will retry)", res.Failed)
	}
	if res.Quarantined > 0 {
		fmt.Printf(", %d permanently skipped", res.Quarantined)
	}
	fmt.Println()
	if len(res.QuarantinedIDs) > 0 {
		fmt.Printf("permanently skipped ids: %s\n", strings.Join(res.QuarantinedIDs, " "))
	}
}

func cmdSearch(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	var o store.SearchOpts
	var since, until string
	var asJSON bool
	fs.StringVar(&o.Source, "source", "", "")
	fs.StringVar(&o.From, "from", "", "")
	fs.StringVar(&o.To, "to", "", "")
	fs.StringVar(&o.Person, "person", "", "")
	fs.Int64Var(&o.MailboxID, "mailbox-id", 0, "")
	fs.StringVar(&o.Subject, "subject", "", "")
	attachment := fs.String("has-attachment", "", "true or false")
	fs.StringVar(&o.Match, "match", "any", "")
	fs.StringVar(&since, "since", "", "")
	fs.StringVar(&until, "until", "", "")
	fs.IntVar(&o.Fuzzy, "fuzzy", 1, "")
	fs.IntVar(&o.Limit, "limit", 20, "")
	fs.IntVar(&o.Offset, "offset", 0, "")
	fs.BoolVar(&asJSON, "json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	query := strings.Join(fs.Args(), " ")
	if *attachment != "" {
		value, err := strconv.ParseBool(*attachment)
		if err != nil || (*attachment != "true" && *attachment != "false") {
			return fmt.Errorf("has-attachment must be true or false")
		}
		o.HasAttachment = &value
	}
	var err error
	if o.Since, err = parseDate(since); err != nil {
		return err
	}
	if o.Until, err = parseDate(until); err != nil {
		return err
	}
	// Checked before the query so local and remote modes reject the same
	// values with the same message, instead of one returning nothing and the
	// other a database error.
	if err := o.Validate(); err != nil {
		return err
	}
	if query != "" {
		if err := o.ValidateQuery(query); err != nil {
			return err
		}
	}

	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	if query == "" {
		groups, err := b.BrowseThreads(ctx, store.BrowseOpts{Source: o.Source, MailboxID: o.MailboxID, Subject: o.Subject, HasAttachment: o.HasAttachment, From: o.From, To: o.To, Person: o.Person, Since: o.Since, Until: o.Until, Limit: o.Limit, Offset: o.Offset})
		if err != nil {
			return err
		}
		if asJSON {
			return printJSON(groups)
		}
		for _, group := range groups {
			fmt.Printf("%6d  %s  %-12s  %d matching messages  %s\n", group.LastID, group.LastAt.Format("2006-01-02"), group.Source, group.Count, group.Subject)
		}
		printMorePages(len(groups), o.Limit, o.Offset)
		return nil
	}
	msgs, err := b.Search(ctx, query, o)
	if err != nil {
		return err
	}
	if asJSON {
		return printJSON(msgs)
	}
	if len(msgs) == 0 {
		fmt.Println("no matches")
		return nil
	}
	for _, m := range msgs {
		title := m.Subject
		if title == "" {
			title = excerpt(m.Body, 100)
		}
		fmt.Printf("%6d  %s  %-8s  %-22s  %s\n",
			m.ID, m.SentAt.Format("2006-01-02"), m.Source, excerpt(m.Sender, 22), title)
		if m.Snippet != "" && m.Snippet != title {
			fmt.Printf("        %s\n", excerpt(m.Snippet, 160))
		}
		if m.AttachmentSnippet != "" {
			fmt.Printf("        in attachment: %s\n", excerpt(m.AttachmentSnippet, 160))
		}
	}
	printMorePages(len(msgs), o.Limit, o.Offset)
	return nil
}

// printMorePages says how to reach the next page. A full page is the signal
// that there may be more — the same rule a --json caller uses, since a short
// page means the end.
func printMorePages(got, limit, offset int) {
	if got < limit {
		return
	}
	next := offset + limit
	if next > store.MaxSearchOffset {
		fmt.Printf("\n… possibly more, but past the --offset %d cap; narrow the query instead\n", store.MaxSearchOffset)
		return
	}
	fmt.Printf("\n… possibly more: repeat with --offset %d\n", next)
}

func cmdThread(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("thread", flag.ExitOnError)
	source := fs.String("source", "", "")
	var o store.ThreadOpts
	fs.IntVar(&o.Limit, "limit", 0, "")
	fs.Int64Var(&o.Before, "before", 0, "")
	fs.Int64Var(&o.After, "after", 0, "")
	fs.Int64Var(&o.Around, "around", 0, "")
	fs.BoolVar(&o.Latest, "latest", false, "")
	fs.BoolVar(&o.Current, "current", false, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("usage: bank thread <id> [--source s] [--around id|--before id|--after id|--latest] [--limit n] [--json]")
	}
	threadID := strings.Join(fs.Args(), " ")

	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	thread, err := b.GetThreadPage(ctx, *source, threadID, o)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no thread %q", threadID)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(thread)
	}
	// One subject shared by every message is the conversation's title, not
	// per-message data: the AI chat sources put it on all of them, and a
	// thread id alone says nothing to a reader. A mail thread, whose subjects
	// vary or are absent, keeps them under each message.
	var title string
	if len(thread.Messages) > 0 {
		title = thread.Messages[0].Subject
		for _, m := range thread.Messages[1:] {
			if m.Subject != title {
				title = ""
				break
			}
		}
	}
	fmt.Printf("thread:  %s\n", thread.ThreadID)
	if title != "" {
		fmt.Printf("title:   %s\n", title)
	}
	fmt.Printf("source:  %s\nmessages: %d\n\n", thread.Source, len(thread.Messages))
	for _, m := range thread.Messages {
		fmt.Printf("[%d] %s  %s\n", m.ID, m.SentAt.Format("2006-01-02 15:04"), m.Sender)
		printReplyInfo(m.Message)
		if m.Subject != "" && m.Subject != title {
			fmt.Printf("    %s\n", m.Subject)
		}
		for _, line := range strings.Split(strings.TrimSpace(m.Body), "\n") {
			fmt.Printf("    %s\n", line)
		}
		fmt.Println()
	}
	if len(thread.Messages) > 0 {
		if thread.HasBefore {
			fmt.Printf("Earlier messages: --before %d\n", thread.Messages[0].ID)
		}
		if thread.HasAfter {
			fmt.Printf("Later messages: --after %d\n", thread.Messages[len(thread.Messages)-1].ID)
		}
	}
	return nil
}

func cmdShow(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	provenance := fs.Bool("provenance", false, "show archive, folder, and mail grouping evidence")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank show <id|ref> [--json] [--provenance]")
	}
	arg := fs.Arg(0)

	remote := client.FromEnv() != nil
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	// A ref is 12 hex characters and is tried first: one made only of digits
	// would otherwise parse as a row id, and no archive reaches 12-digit ids.
	var d store.MessageDetail
	if store.ValidRef(arg) == nil {
		d, err = b.GetMessageDetailByRef(ctx, arg)
	} else {
		id, parseErr := strconv.ParseInt(arg, 10, 64)
		if parseErr != nil {
			return fmt.Errorf("invalid id or ref %q (a ref is %d hex characters)", arg, store.RefChars)
		}
		d, err = b.GetMessageDetail(ctx, id)
	}
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no message %s", arg)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(d)
	}

	m := d.Message
	printReplyInfo(m)
	fmt.Printf("id:      %d\nref:     %s\nsource:  %s\nthread:  %s\nfrom:    %s\ndate:    %s\n",
		m.ID, m.Ref, m.Source, m.ThreadID, m.Sender, m.SentAt.Format(time.RFC1123))
	if len(m.Recipients) > 0 {
		fmt.Printf("to:      %s\n", strings.Join(m.Recipients, ", "))
	}
	if m.Subject != "" {
		fmt.Printf("subject: %s\n", m.Subject)
	}
	if *provenance {
		printProvenance(m)
	}
	fmt.Printf("\n%s\n", m.Body)
	if len(d.Attachments) > 0 {
		fmt.Println()
		var blobs *blob.Store
		if !remote {
			blobs, _ = blob.New(filepath.Join(dataDir(), "blobs"))
		}
		for _, a := range d.Attachments {
			where := fmt.Sprintf("bank fetch %s", a.SHA256)
			if blobs != nil {
				where = blobs.Path(a.SHA256)
			}
			fmt.Printf("attachment: %s (%d bytes)  %s\n", a.Filename, a.SizeBytes, where)
			if a.TextStatus != "" {
				fmt.Printf("            text: %s", a.TextStatus)
				if a.TextChars > 0 {
					fmt.Printf(" (%s characters, searchable)", humanCount(int64(a.TextChars)))
				}
				fmt.Println()
			}
		}
	}
	return nil
}

func printProvenance(m store.Message) {
	recorded := func(value string) string {
		if value == "" {
			return "not recorded"
		}
		return value
	}
	fmt.Printf("external ID: %s\noriginal archive input: %s\n", recorded(m.ExternalID), recorded(m.RawRef))
	if len(m.Mailboxes) == 0 {
		fmt.Println("observed folders: not recorded")
	}
	for _, mailbox := range m.Mailboxes {
		fmt.Printf("observed folder: %s (%s, historical)\n", mailbox.Path, mailbox.Kind)
	}
	if mail := m.Mail; mail != nil {
		fmt.Printf("header archive input: %s\nnormalized Message-ID: %s\nIn-Reply-To: %s\nReferences: %s\nprovider thread ID: %s\nreply links: %t\ngrouping incomplete: %t\nconflict key: %s\n",
			recorded(mail.RawRef), recorded(mail.MessageID), recorded(strings.Join(mail.InReplyTo, ", ")), recorded(strings.Join(mail.References, ", ")), recorded(mail.NativeThreadID), mail.HasReplyLinks, mail.Incomplete, recorded(mail.ConflictKey))
	}
}

// backend is the archive as the read commands use it. The local store and a
// remote `bank serve` answer to the same method names, so no command below
// has to know which it is talking to.
type backend interface {
	ListMailboxes(context.Context, string) ([]store.Mailbox, error)
	BrowseThreads(context.Context, store.BrowseOpts) ([]store.ThreadGroup, error)
	MailConflictMessages(context.Context, string, string, int64, int) (store.Thread, error)
	ImportReports(context.Context, int64, int) ([]store.ImportReport, error)
	AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error)
	AttachmentMessages(context.Context, string, int, int) ([]store.Message, error)
	Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error)
	GetMessageDetail(ctx context.Context, id int64) (store.MessageDetail, error)
	GetMessageDetailByRef(ctx context.Context, ref string) (store.MessageDetail, error)
	GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
	SetCoverage(ctx context.Context, source, text string) error
	CreateContact(ctx context.Context, name, note string) (store.Contact, error)
	ImportContacts(ctx context.Context, in []store.ContactImport) ([]store.ContactImportResult, error)
	DeleteContact(ctx context.Context, name string) error
	ListContacts(ctx context.Context) ([]store.Contact, error)
	GetContactDetail(ctx context.Context, name string) (store.ContactDetail, error)
	AddAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error)
	RemoveAlias(ctx context.Context, name, source, value string) error
	ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.MessageDetail, error)
	SuggestIdentities(ctx context.Context, limit int) ([]store.IdentitySuggestion, error)
	Query(ctx context.Context, query string, limit int) (store.QueryResult, error)
}

func openBackend(ctx context.Context) (backend, func(), error) {
	if c := client.FromEnv(); c != nil {
		return c, func() {}, nil
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	return st, st.Close, nil
}

func cmdStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	stats, err := b.Stats(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(stats)
	}
	if len(stats) == 0 {
		fmt.Println("archive is empty")
		return nil
	}
	var total int64
	for _, s := range stats {
		fmt.Printf("%-12s %8d messages  %s — %s  last import %s",
			s.Source, s.Messages, s.Earliest.Format("2006-01-02"), s.Latest.Format("2006-01-02"),
			s.LastIngest.Format("2006-01-02"))
		if s.LastSync != nil {
			fmt.Printf("  synced %s", s.LastSync.Format("2006-01-02 15:04"))
		}
		if s.Stale {
			fmt.Print("  (stale)")
		}
		fmt.Println()
		if s.Coverage != "" {
			fmt.Printf("%-12s %s\n", "", s.Coverage)
		}
		total += s.Messages
	}
	fmt.Printf("%-12s %8d messages\n", "total", total)
	if anyStale(stats) {
		fmt.Printf("\n(stale) means nothing new in %d days — a gap there may be a broken import, not a quiet month\n",
			int(store.StaleAfter.Hours()/24))
	}

	// Coverage belongs in "how much of my archive can I actually search", but
	// not in --json: that payload is a list of sources and agents already
	// parse it. `bank attachment stats --json` is the machine-readable form.
	if b, closeBackend, err := openAttachments(ctx); err == nil {
		defer closeBackend()
		if ext, err := b.ExtractionStats(ctx); err == nil && len(ext) > 0 {
			fmt.Println()
			printExtractionStats(ext)
		}
	}
	return nil
}

func anyStale(stats []store.SourceStats) bool {
	return slices.ContainsFunc(stats, func(s store.SourceStats) bool { return s.Stale })
}

// cmdCoverage maintains the per-source note on what the archive actually holds
// — the context that turns "search found nothing" into either "it did not
// happen" or "that period was never imported".
func cmdCoverage(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("coverage", flag.ExitOnError)
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() < 1 {
		return fmt.Errorf("usage: bank coverage <source> <text>   (empty text clears the note)")
	}
	source, text := fs.Arg(0), strings.Join(fs.Args()[1:], " ")
	if err := archive.ValidSource(source); err != nil {
		return err
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	if err := b.SetCoverage(ctx, source, text); err != nil {
		return err
	}
	if text == "" {
		fmt.Printf("%s: coverage note cleared\n", source)
		return nil
	}
	fmt.Printf("%s: %s\n", source, text)
	return nil
}

// schemaSQL is what --schema runs: the public base tables and their columns,
// which is exactly the map an agent needs before writing its first query.
const schemaSQL = `select c.table_name, c.column_name, c.data_type
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
order by c.table_name, c.ordinal_position`

func cmdQuery(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("query", flag.ExitOnError)
	limit := fs.Int("limit", 0, "")
	asJSON := fs.Bool("json", false, "")
	schema := fs.Bool("schema", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	var query string
	switch {
	case *schema:
		if fs.NArg() != 0 {
			return fmt.Errorf("--schema takes no query argument")
		}
		query = schemaSQL
	case fs.NArg() != 1:
		return fmt.Errorf("usage: bank query <sql|-> [--limit n] [--json], or bank query --schema")
	case fs.Arg(0) == "-":
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		query = string(b)
	default:
		query = fs.Arg(0)
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	res, err := b.Query(ctx, query, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(res)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, strings.Join(res.Columns, "\t"))
	for _, row := range res.Rows {
		cells := make([]string, len(row))
		for i, v := range row {
			cells[i] = queryCell(v)
		}
		fmt.Fprintln(w, strings.Join(cells, "\t"))
	}
	if err := w.Flush(); err != nil {
		return err
	}
	if res.Truncated {
		fmt.Fprintf(os.Stderr, "(truncated at %d rows; raise --limit or aggregate)\n", len(res.Rows))
	}
	return nil
}

// queryCell renders one value for the text table: single line, bounded width,
// so a body column cannot wreck the terminal. --json is the faithful form.
func queryCell(v any) string {
	var s string
	switch x := v.(type) {
	case nil:
		return "∅"
	case string:
		s = x
	case time.Time:
		return x.Format("2006-01-02 15:04:05")
	default:
		if b, err := json.Marshal(x); err == nil {
			s = string(b)
		} else {
			s = fmt.Sprint(x)
		}
	}
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 120 {
		s = s[:117] + "..."
	}
	return s
}

func cmdFetch(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	out := fs.String("o", "", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank fetch <sha256> [-o path]")
	}
	sum := fs.Arg(0)
	if err := blob.ValidDigest(sum); err != nil {
		return err
	}
	dest := *out
	if dest == "" {
		dest = sum
	}

	var src io.ReadCloser
	var err error
	if c := client.FromEnv(); c != nil {
		src, err = c.Blob(ctx, sum)
	} else {
		var blobs *blob.Store
		if blobs, err = blob.New(filepath.Join(dataDir(), "blobs")); err == nil {
			src, err = os.Open(blobs.Path(sum))
		}
	}
	if err != nil {
		return fmt.Errorf("%s: %w", sum, err)
	}
	defer src.Close()

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, src)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	fmt.Printf("%s (%d bytes)\n", dest, n)
	return nil
}

func cmdVerify(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	heal := fs.Bool("heal", false, "")
	source := fs.String("source", "", "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if client.FromEnv() != nil {
		return fmt.Errorf("verify reads the archive and blob store directly; run it on the server, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	rep, err := verify.Run(ctx, d.st, d.blobs, d.archiveDir, verify.Options{Source: *source, Heal: *heal})
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(rep)
	}
	for _, f := range rep.Findings {
		state := "damaged"
		if f.Repaired {
			state = "repaired"
		}
		fmt.Printf("%-9s message %d %-20s %s\n", state, f.MessageID, f.Kind, f.Detail)
	}
	if rep.Damaged == 0 {
		fmt.Printf("%d messages, %d attachments checked: no damage found\n",
			rep.MessagesChecked, rep.AttachmentsChecked)
		return nil
	}
	fmt.Printf("%d messages, %d attachments checked: %s (%d repaired, %d unrecoverable)\n",
		rep.MessagesChecked, rep.AttachmentsChecked, plural(rep.Damaged, "problem"), rep.Repaired, rep.Unrecoverable)
	if len(rep.Findings) < rep.Damaged {
		fmt.Printf("(showing the first %d findings)\n", len(rep.Findings))
	}
	if !*heal {
		fmt.Println("run 'bank verify --heal' to rebuild what the archived raw inputs still contain")
	}
	return nil
}

func cmdServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:8480", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	if names, err := server.ListTokens(dataDir()); err == nil && len(names) == 0 {
		fmt.Fprintln(os.Stderr, "bank: no tokens yet — every /v1 request will 401 until 'bank token new <name>'")
	}
	srv := server.New(d.st, d.blobs, dataDir(), d.archiveDir)
	fmt.Printf("bank serve: listening on %s\n", *listen)
	return srv.ListenAndServe(*listen)
}

// cmdUI starts the local archive browser: the embedded page plus a proxy that
// signs /v1 requests with BANK_TOKEN, so the token stays out of the browser.
func cmdUI(args []string) error {
	fs := flag.NewFlagSet("ui", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:8481", "")
	noOpen := fs.Bool("no-open", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	base := os.Getenv("BANK_URL")
	if base == "" {
		return fmt.Errorf("ui needs BANK_URL (and BANK_TOKEN) pointing at a 'bank serve'; on the server box, set BANK_URL=http://127.0.0.1:8480")
	}
	apiBase, err := url.Parse(base)
	if err != nil {
		return fmt.Errorf("invalid BANK_URL: %w", err)
	}
	addr := "http://" + *listen
	fmt.Printf("bank ui: %s -> %s\n", addr, base)
	if !*noOpen {
		openBrowser(addr)
	}
	srv := &http.Server{Addr: *listen, Handler: webui.Handler(apiBase, os.Getenv("BANK_TOKEN")),
		ReadHeaderTimeout: 15 * time.Second}
	return srv.ListenAndServe()
}

func openBrowser(u string) {
	cmds := map[string][]string{"darwin": {"open"}, "windows": {"cmd", "/c", "start"}}
	c, ok := cmds[runtime.GOOS]
	if !ok {
		c = []string{"xdg-open"}
	}
	if err := exec.Command(c[0], append(c[1:], u)...).Start(); err != nil {
		fmt.Fprintf(os.Stderr, "bank: open %s in your browser (%v)\n", u, err)
	}
}

func cmdToken(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: bank token <new|list|revoke> [name]")
	}
	// The token file is only ever read by the server, so writing one anywhere
	// else produces a token that looks valid and 401s on every request. Being
	// told the path afterwards is the diagnosis; refusing is the cure.
	if client.FromEnv() != nil {
		return fmt.Errorf("token writes the file the server checks on every request; run it there, not through BANK_URL")
	}
	switch args[0] {
	case "new":
		if len(args) != 2 {
			return fmt.Errorf("usage: bank token new <name>")
		}
		token, err := server.NewToken(dataDir(), args[1])
		if err != nil {
			return err
		}
		// Only the digest is stored, so this is the one chance to copy it.
		// The directory is printed because a token written into the wrong
		// BANK_DATA_DIR is the usual reason a server keeps answering 401.
		fmt.Fprintf(os.Stderr, "token stored in %s\n", server.TokensPath(dataDir()))
		fmt.Println(token)
	case "list":
		names, err := server.ListTokens(dataDir())
		if err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "tokens in %s\n", server.TokensPath(dataDir()))
		for _, n := range names {
			fmt.Println(n)
		}
	case "revoke":
		if len(args) != 2 {
			return fmt.Errorf("usage: bank token revoke <name>")
		}
		return server.RevokeToken(dataDir(), args[1])
	default:
		return fmt.Errorf("usage: bank token <new|list|revoke> [name]")
	}
	return nil
}

// parseFlagsAnywhere lets flags follow positional args (bank search foo --json).
func parseFlagsAnywhere(fs *flag.FlagSet, args []string) error {
	var positional []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return err
		}
		args = fs.Args()
		if len(args) == 0 {
			break
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
	return fs.Parse(positional)
}

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q, want YYYY-MM-DD", s)
	}
	return t, nil
}

func printJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
