// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"
	// Embedded so a container without tzdata still resolves the local zone.
	// Dates typed as YYYY-MM-DD and WhatsApp export timestamps are read in
	// local time, so an image that silently fell back to UTC would shift them.
	_ "time/tzdata"

	"github.com/alecthomas/kong"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/gmail"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/verify"
	"github.com/aquitano/aqt/apps/bank/internal/webui"
)

const description = `bank — personal message archive

Environment:
  DATABASE_URL             default ` + defaultDatabaseURL + `
  BANK_QUERY_DATABASE_URL  separate restricted login for ad-hoc SQL
  BANK_DATA_DIR            default ~/.local/share/aqt-bank (blobs/, archive/, inbox/)
  BANK_URL                 talk to a remote 'bank serve' instead of Postgres
  BANK_TOKEN               bearer token for BANK_URL (see 'bank token new')`

type cli struct {
	Version kong.VersionFlag `help:"Print the build revision."`

	VersionCmd  versionCmd     `cmd:"" name:"version" help:"Print the build revision."`
	Help        helpCmd        `cmd:"" hidden:"" help:"Show help for a command."`
	Auth        authCmd        `cmd:"" help:"Authorize an account."`
	Sync        syncCmd        `cmd:"" help:"Pull new mail from Gmail."`
	IMAP        imapCmd        `cmd:"" name:"imap" help:"Collect IMAP mail continuously, once, or check the login."`
	Mail        mailCmd        `cmd:"" help:"Observed folders, metadata rebuilds and thread conflicts."`
	Import      importCmd      `cmd:"" help:"Import exports into the archive."`
	Reimport    reimportCmd    `cmd:"" help:"Replay archived inputs through the current importer."`
	Extract     extractCmd     `cmd:"" help:"Read text out of attachments."`
	Attachment  attachmentCmd  `cmd:"" help:"Attachment content and its text."`
	Reports     reportsCmd     `cmd:"" help:"Saved import outcomes and gaps."`
	Library     libraryCmd     `cmd:"" help:"Media, activity, collections, files and page indexing."`
	Search      searchCmd      `cmd:"" help:"Grouped archive search, or filtered conversations without a query."`
	Thread      threadCmd      `cmd:"" help:"One conversation page, oldest first."`
	Contact     contactCmd     `cmd:"" help:"One person across their many identities."`
	Show        showCmd        `cmd:"" help:"Print one message and its attachments."`
	Stats       statsCmd       `cmd:"" help:"Per-source counts, date ranges and freshness."`
	Coverage    coverageCmd    `cmd:"" help:"Note what a source holds (empty text clears)."`
	Query       queryCmd       `cmd:"" help:"Read-only ad-hoc SQL: READ ONLY tx, 15s timeout, row cap 100."`
	Fetch       fetchCmd       `cmd:"" help:"Write an attachment to a file."`
	Verify      verifyCmd      `cmd:"" help:"Check archive integrity, optionally repair."`
	Healthcheck healthcheckCmd `cmd:"" help:"Check server and database health."`
	Serve       serveCmd       `cmd:"" help:"HTTP API."`
	UI          uiCmd          `cmd:"" name:"ui" help:"Local archive browser (needs BANK_URL)."`
	Token       tokenCmd       `cmd:"" help:"API tokens."`
}

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stderr)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := execute(ctx, args)
	if err == nil {
		return 0
	}
	fmt.Fprintln(os.Stderr, "bank:", err)
	if parseErr, ok := errors.AsType[*kong.ParseError](err); ok && (parseErr.Context == nil || parseErr.Context.Selected() == nil) {
		fmt.Fprintln(os.Stderr)
		printUsage(os.Stderr)
		return 2
	}
	return 1
}

func newParser(root *cli) *kong.Kong {
	return kong.Must(root,
		kong.Name("bank"),
		kong.Description(description),
		kong.Vars{"version": buildVersion()},
		kong.WithHyphenPrefixedParameters(true),
	)
}

func execute(ctx context.Context, args []string) error {
	kctx, err := newParser(&cli{}).Parse(args)
	if err != nil {
		return err
	}
	kctx.BindTo(ctx, (*context.Context)(nil))
	return kctx.Run()
}

func printUsage(w io.Writer) {
	parser := newParser(&cli{})
	parser.Stdout = w
	if err := printHelp(parser, nil); err != nil {
		fmt.Fprintln(os.Stderr, "bank:", err)
	}
}

func printHelp(parser *kong.Kong, path []string) error {
	target, err := kong.Trace(parser, path)
	if err != nil {
		return err
	}
	if target.Error != nil {
		return target.Error
	}
	return target.PrintUsage(false)
}

type versionCmd struct{}

func (versionCmd) Run() error {
	fmt.Println(buildVersion())
	return nil
}

// helpCmd answers `bank help [command]` and `bank <group> help`, the spellings
// the old usage text advertised alongside --help.
type helpCmd struct {
	Command []string `arg:"" optional:""`
}

func (h *helpCmd) Run(kctx *kong.Context) error {
	var path []string
	for n := kctx.Selected().Parent; n != nil && n.Type == kong.CommandNode; n = n.Parent {
		path = append([]string{n.Name}, path...)
	}
	return printHelp(kctx.Kong, append(path, h.Command...))
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

const defaultDatabaseURL = "postgres://bank:bank@localhost:5433/bank?sslmode=disable"

func databaseURL() string {
	if url := os.Getenv("DATABASE_URL"); url != "" {
		return url
	}
	return defaultDatabaseURL
}

func openStore(ctx context.Context) (*store.Store, error) {
	st, err := store.Open(ctx, databaseURL())
	if err != nil {
		return nil, err
	}
	if queryURL := os.Getenv("BANK_QUERY_DATABASE_URL"); queryURL != "" {
		if err := st.ConfigureQuery(ctx, queryURL); err != nil {
			st.Close()
			return nil, err
		}
	}
	return st, nil
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

type authCmd struct {
	Gmail authGmailCmd `cmd:"" help:"Authorize Gmail (loopback OAuth)."`
}

type authGmailCmd struct {
	Port int    `help:"Loopback port for the OAuth redirect."`
	Bind string `default:"127.0.0.1" help:"Address the OAuth listener binds."`
}

func (c *authGmailCmd) Run(ctx context.Context) error {
	return gmail.Authorize(ctx, dataDir(), c.Bind, c.Port)
}

type syncCmd struct {
	Full bool `help:"Re-fetch existing mail instead of history deltas."`
}

func (c *syncCmd) Run(ctx context.Context) error {
	if client.FromEnv() != nil {
		return fmt.Errorf("sync reads the OAuth token beside the blob store and writes rows, blobs and raw mail together; run it on the server, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	res, err := gmail.Sync(ctx, d.st, d.blobs, dataDir(), d.archiveDir, c.Full)
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

type searchCmd struct {
	Query         []string `arg:"" optional:"" help:"Search words; without them, browse filtered conversations."`
	Kind          string   `help:"message, item, activity, collection, file, page, or media subtype."`
	Account       string   `help:"Filter library records by source account."`
	Source        string   `help:"Filter by source (whatsapp, gmail, ...)."`
	From          string   `help:"Sender contains this (case-insensitive)."`
	To            string   `help:"Recipient contains this (case-insensitive)."`
	Person        string   `help:"Filter by contact, across all their aliases."`
	MailboxID     int64    `help:"Observed folder id from bank mail mailboxes; requires --source."`
	Subject       string   `help:"Subject contains this literal text, case-insensitive."`
	HasAttachment string   `help:"true or false."`
	Match         string   `default:"any" help:"any, all words, or phrase."`
	Since         string   `help:"YYYY-MM-DD."`
	Until         string   `help:"YYYY-MM-DD (exclusive)."`
	Fuzzy         int      `default:"1" help:"Typo tolerance 0-2 (ignored for phrase)."`
	Limit         int      `default:"20" help:"Max results, 1-500."`
	Offset        int      `help:"Skip this many ranked results, for the next page (max 10000)."`
	JSON          bool     `help:"JSON output."`
}

func (c *searchCmd) Run(ctx context.Context) error {
	o := store.SearchOpts{Source: c.Source, From: c.From, To: c.To, Person: c.Person, MailboxID: c.MailboxID, Subject: c.Subject, Match: c.Match, Fuzzy: c.Fuzzy, Limit: c.Limit, Offset: c.Offset}
	query := strings.Join(c.Query, " ")
	if c.HasAttachment != "" {
		value, err := strconv.ParseBool(c.HasAttachment)
		if err != nil || (c.HasAttachment != "true" && c.HasAttachment != "false") {
			return fmt.Errorf("has-attachment must be true or false")
		}
		o.HasAttachment = &value
	}
	var err error
	if o.Since, err = parseDate(c.Since); err != nil {
		return err
	}
	if o.Until, err = parseDate(c.Until); err != nil {
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
		if c.Kind != "" || c.Account != "" {
			return fmt.Errorf("kind/account require a search query; use bank library list to browse library records")
		}
		groups, err := b.BrowseThreads(ctx, store.BrowseOpts{Source: o.Source, MailboxID: o.MailboxID, Subject: o.Subject, HasAttachment: o.HasAttachment, From: o.From, To: o.To, Person: o.Person, Since: o.Since, Until: o.Until, Limit: o.Limit, Offset: o.Offset})
		if err != nil {
			return err
		}
		if c.JSON {
			return printJSON(groups)
		}
		for _, group := range groups {
			fmt.Printf("%6d  %s  %-12s  %d matching messages  %s\n", group.LastID, group.LastAt.Format("2006-01-02"), group.Source, group.Count, group.Subject)
		}
		printMorePages(len(groups), o.Limit, o.Offset)
		return nil
	}
	findOptions := library.ListOptions{Query: query, Source: o.Source, Account: c.Account, Kind: c.Kind, Since: c.Since, Until: c.Until, Limit: o.Limit, Offset: o.Offset}
	var result catalog.Result
	if remote, ok := b.(*client.Client); ok {
		result, err = remote.Find(ctx, query, o, findOptions)
	} else {
		result, err = catalog.Find(ctx, b, query, o, findOptions)
	}
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(result)
	}
	return printCatalog(result, o.Limit, o.Offset)
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

type threadCmd struct {
	ID      []string `arg:"" help:"Thread id; several words are joined with spaces."`
	Source  string   `help:"Source the thread belongs to."`
	Limit   int      `help:"Page size, 1-2000 (default 2000)."`
	Before  int64    `help:"Page backward from this message."`
	After   int64    `help:"Page forward from this message."`
	Around  int64    `help:"Center context on this message's numeric id."`
	Latest  bool     `help:"Start at the newest page."`
	Current bool     `help:"Read a current subgroup instead of resolving its historical alias."`
	JSON    bool     `help:"JSON output, including has_before, has_after and attachments."`
}

func (c *threadCmd) Run(ctx context.Context) error {
	threadID := strings.Join(c.ID, " ")
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	thread, err := b.GetThreadPage(ctx, c.Source, threadID, store.ThreadOpts{Limit: c.Limit, Before: c.Before, After: c.After, Around: c.Around, Latest: c.Latest, Current: c.Current})
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no thread %q", threadID)
	}
	if err != nil {
		return err
	}
	if c.JSON {
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

type showCmd struct {
	Ref        string `arg:"" help:"Message id, or the 12-character ref a citation carries."`
	JSON       bool   `help:"JSON output."`
	Provenance bool   `help:"Show archive, folder, and mail grouping evidence."`
}

func (c *showCmd) Run(ctx context.Context) error {
	remote := client.FromEnv() != nil
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	// A ref is 12 hex characters and is tried first: one made only of digits
	// would otherwise parse as a row id, and no archive reaches 12-digit ids.
	var d store.MessageDetail
	if store.ValidRef(c.Ref) == nil {
		d, err = b.GetMessageDetailByRef(ctx, c.Ref)
	} else {
		id, parseErr := strconv.ParseInt(c.Ref, 10, 64)
		if parseErr != nil {
			return fmt.Errorf("invalid id or ref %q (a ref is %d hex characters)", c.Ref, store.RefChars)
		}
		d, err = b.GetMessageDetail(ctx, id)
	}
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no message %s", c.Ref)
	}
	if err != nil {
		return err
	}
	if c.JSON {
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
	if c.Provenance {
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
	SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error)
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

type statsCmd struct {
	JSON bool `help:"JSON output."`
}

func (c *statsCmd) Run(ctx context.Context) error {
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	stats, err := b.Stats(ctx)
	if err != nil {
		return err
	}
	if c.JSON {
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

// coverageCmd maintains the per-source note on what the archive actually holds
// — the context that turns "search found nothing" into either "it did not
// happen" or "that period was never imported".
type coverageCmd struct {
	Source string   `arg:""`
	Text   []string `arg:"" optional:"" help:"The note; omit it to clear."`
}

func (c *coverageCmd) Run(ctx context.Context) error {
	text := strings.Join(c.Text, " ")
	if err := archive.ValidSource(c.Source); err != nil {
		return err
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	if err := b.SetCoverage(ctx, c.Source, text); err != nil {
		return err
	}
	if text == "" {
		fmt.Printf("%s: coverage note cleared\n", c.Source)
		return nil
	}
	fmt.Printf("%s: %s\n", c.Source, text)
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

type queryCmd struct {
	SQL    string `arg:"" optional:"" help:"One SQL statement, or - to read it from stdin."`
	Limit  int    `help:"Row cap, up to 10000 (default 100)."`
	JSON   bool   `help:"JSON output."`
	Schema bool   `help:"List tables and columns."`
}

func (c *queryCmd) Run(ctx context.Context) error {
	query := c.SQL
	switch {
	case c.Schema:
		if c.SQL != "" {
			return fmt.Errorf("--schema takes no query argument")
		}
		query = schemaSQL
	case c.SQL == "":
		return fmt.Errorf("usage: bank query <sql|-> [--limit n] [--json], or bank query --schema")
	case c.SQL == "-":
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		query = string(b)
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	res, err := b.Query(ctx, query, c.Limit)
	if err != nil {
		return err
	}
	if c.JSON {
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

type fetchCmd struct {
	SHA256 string `arg:"" name:"sha256"`
	Output string `short:"o" help:"Destination path (default: the digest)."`
}

func (c *fetchCmd) Run(ctx context.Context) error {
	if err := blob.ValidDigest(c.SHA256); err != nil {
		return err
	}
	dest := c.Output
	if dest == "" {
		dest = c.SHA256
	}

	var src io.ReadCloser
	var err error
	if remote := client.FromEnv(); remote != nil {
		src, err = remote.Blob(ctx, c.SHA256)
	} else {
		var blobs *blob.Store
		if blobs, err = blob.New(filepath.Join(dataDir(), "blobs")); err == nil {
			src, err = os.Open(blobs.Path(c.SHA256))
		}
	}
	if err != nil {
		return fmt.Errorf("%s: %w", c.SHA256, err)
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

type verifyCmd struct {
	Heal   bool   `help:"Rebuild what the archived raw inputs still contain."`
	Source string `help:"Only check this source."`
	JSON   bool   `help:"JSON output."`
}

func (c *verifyCmd) Run(ctx context.Context) error {
	if client.FromEnv() != nil {
		return fmt.Errorf("verify reads the archive and blob store directly; run it on the server, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	rep, err := verify.Run(ctx, d.st, d.blobs, d.archiveDir, verify.Options{Source: c.Source, Heal: c.Heal})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(rep)
	}
	for _, f := range rep.Findings {
		state := "damaged"
		if f.Repaired {
			state = "repaired"
		}
		if f.LibraryID != "" {
			fmt.Printf("%-9s %s %s %-20s %s\n", state, f.LibraryKind, f.LibraryID, f.Kind, f.Detail)
		} else {
			fmt.Printf("%-9s message %d %-20s %s\n", state, f.MessageID, f.Kind, f.Detail)
		}
	}
	checked := fmt.Sprintf("%d messages, %d attachments, %d library records, %d library files checked", rep.MessagesChecked, rep.AttachmentsChecked, rep.LibraryRecordsChecked, rep.LibraryFilesChecked)
	if rep.Damaged == 0 {
		fmt.Printf("%s: no damage found\n", checked)
		return nil
	}
	fmt.Printf("%s: %s (%d repaired, %d unrecoverable)\n", checked, plural(rep.Damaged, "problem"), rep.Repaired, rep.Unrecoverable)
	if len(rep.Findings) < rep.Damaged {
		fmt.Printf("(showing the first %d findings)\n", len(rep.Findings))
	}
	if !c.Heal {
		fmt.Println("run 'bank verify --heal' to rebuild what the archived raw inputs still contain")
	}
	return nil
}

type serveCmd struct {
	Listen string `default:"127.0.0.1:8480" help:"Address to listen on."`
}

func (c *serveCmd) Run(ctx context.Context) error {
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	if names, err := server.ListTokens(dataDir()); err == nil && len(names) == 0 {
		fmt.Fprintln(os.Stderr, "bank: no tokens yet — every /v1 request will 401 until 'bank token new <name>'")
	}
	srv := server.New(d.st, d.blobs, dataDir(), d.archiveDir)
	fmt.Printf("bank serve: listening on %s\n", c.Listen)
	return srv.ListenAndServe(ctx, c.Listen)
}

// uiCmd starts the local archive browser: the embedded page plus a proxy that
// signs /v1 requests with BANK_TOKEN, so the token stays out of the browser.
type uiCmd struct {
	Listen      string `default:"127.0.0.1:8481" help:"Address to listen on."`
	NoOpen      bool   `help:"Do not open a browser."`
	AllowedHost string `help:"Hostname accepted by the local UI proxy."`
}

func (c *uiCmd) Run(ctx context.Context) error {
	base := os.Getenv("BANK_URL")
	if base == "" {
		return fmt.Errorf("ui needs BANK_URL (and BANK_TOKEN) pointing at a 'bank serve'; on the server box, set BANK_URL=http://127.0.0.1:8480")
	}
	apiBase, err := url.Parse(base)
	if err != nil {
		return fmt.Errorf("invalid BANK_URL: %w", err)
	}
	listenHost, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("invalid UI listen address: %w", err)
	}
	if (listenHost == "" || listenHost == "0.0.0.0" || listenHost == "::") && c.AllowedHost == "" {
		return fmt.Errorf("wildcard UI listener requires --allowed-host with the hostname used to open it")
	}
	acceptedHosts := []string{listenHost}
	if c.AllowedHost != "" {
		acceptedHosts = append(acceptedHosts, c.AllowedHost)
	}
	addr := "http://" + c.Listen
	fmt.Printf("bank ui: %s -> %s\n", addr, base)
	if !c.NoOpen {
		openBrowser(addr)
	}
	srv := &http.Server{Addr: c.Listen, Handler: webui.Handler(apiBase, os.Getenv("BANK_TOKEN"), acceptedHosts...),
		ReadHeaderTimeout: 15 * time.Second}
	return server.Run(ctx, srv)
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

type tokenCmd struct {
	New    tokenNewCmd    `cmd:"" help:"Mint an API token (printed once)."`
	List   tokenListCmd   `cmd:"" help:"Token names."`
	Revoke tokenRevokeCmd `cmd:"" help:"Drop a token."`
}

// refuseRemoteToken guards every token command: the token file is only ever
// read by the server, so writing one anywhere else produces a token that looks
// valid and 401s on every request. Being told the path afterwards is the
// diagnosis; refusing is the cure.
func refuseRemoteToken() error {
	if client.FromEnv() != nil {
		return fmt.Errorf("token writes the file the server checks on every request; run it there, not through BANK_URL")
	}
	return nil
}

type tokenNewCmd struct {
	Name string `arg:""`
}

func (c *tokenNewCmd) Run() error {
	if err := refuseRemoteToken(); err != nil {
		return err
	}
	token, err := server.NewToken(dataDir(), c.Name)
	if err != nil {
		return err
	}
	// Only the digest is stored, so this is the one chance to copy it.
	// The directory is printed because a token written into the wrong
	// BANK_DATA_DIR is the usual reason a server keeps answering 401.
	fmt.Fprintf(os.Stderr, "token stored in %s\n", server.TokensPath(dataDir()))
	fmt.Println(token)
	return nil
}

type tokenListCmd struct{}

func (tokenListCmd) Run() error {
	if err := refuseRemoteToken(); err != nil {
		return err
	}
	names, err := server.ListTokens(dataDir())
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "tokens in %s\n", server.TokensPath(dataDir()))
	for _, n := range names {
		fmt.Println(n)
	}
	return nil
}

type tokenRevokeCmd struct {
	Name string `arg:""`
}

func (c *tokenRevokeCmd) Run() error {
	if err := refuseRemoteToken(); err != nil {
		return err
	}
	return server.RevokeToken(dataDir(), c.Name)
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

var version = "dev"

func buildVersion() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		revision, dirty := "", false
		for _, setting := range info.Settings {
			if setting.Key == "vcs.revision" {
				revision = setting.Value
			}
			if setting.Key == "vcs.modified" {
				dirty = setting.Value == "true"
			}
		}
		if revision != "" {
			if dirty {
				revision += "-dirty"
			}
			return revision
		}
	}
	return version
}

type healthcheckCmd struct {
	URL string `arg:"" optional:"" default:"http://127.0.0.1:8480/healthz"`
}

func (c *healthcheckCmd) Run(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: %s", response.Status)
	}
	return nil
}
