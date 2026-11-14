// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/attic/diskcmd"
	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/gmail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/jobs"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
	"github.com/aquitano/aqt/apps/bank/internal/verify"
	"github.com/aquitano/aqt/apps/bank/internal/webui"
	"github.com/aquitano/aqt/apps/bank/internal/worker"
	"github.com/aquitano/aqt/packages/go/extract"
)

const description = `bank — personal message archive

Environment:
  DATABASE_URL             default ` + db.DefaultURL + `
  BANK_QUERY_DATABASE_URL  separate restricted login for ad-hoc SQL
  BANK_DATA_DIR            default ~/.local/share/aqt-bank (blobs/, inbox/)
  BANK_URL                 call a remote 'bank serve' instead of serving the API in process
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
	Reimport    reimportCmd    `cmd:"" help:"Replay stored raw inputs through today's sources."`
	Extract     extractCmd     `cmd:"" help:"Read text out of attachments."`
	Attachment  attachmentCmd  `cmd:"" help:"Attachment content and its text."`
	Reports     reportsCmd     `cmd:"" help:"Stored raw inputs and the outcome of their latest import."`
	Library     libraryCmd     `cmd:"" help:"Media, activity, collections, files and page indexing."`
	Search      searchCmd      `cmd:"" help:"Grouped archive search, or filtered conversations without a query."`
	Thread      threadCmd      `cmd:"" help:"One conversation page, oldest first."`
	Contact     contactCmd     `cmd:"" help:"One person across their many identities."`
	Show        showCmd        `cmd:"" help:"Print any cited record (msg:…, content:…, or a library ID such as item:…) and where the same bytes are elsewhere."`
	Stats       statsCmd       `cmd:"" help:"Per-source counts, date ranges and freshness, and the files on disks in numbers."`
	Timeline    timelineCmd    `cmd:"" help:"What happened in a year, month or day: messages, activity and files on disks."`
	MCP         mcpCmd         `cmd:"" name:"mcp" help:"Offer the archive's read operations to agents as MCP tools on stdin and stdout."`
	OpenAPI     openapiCmd     `cmd:"" name:"openapi" help:"Print the OpenAPI document of the typed routes." hidden:""`
	Note        noteCmd        `cmd:"" help:"Note what a source holds (empty text clears)."`
	Query       queryCmd       `cmd:"" help:"Read-only ad-hoc SQL: READ ONLY tx, 15s timeout, row cap 100."`
	Fetch       fetchCmd       `cmd:"" help:"Write an attachment to a file."`
	Verify      verifyCmd      `cmd:"" help:"Check that every stored blob is present and intact."`
	Retire      retireCmd      `cmd:"" help:"Delete messages by external id prefix, keeping tombstones."`
	Healthcheck healthcheckCmd `cmd:"" help:"Check server and database health."`
	Migrate     migrateCmd     `cmd:"" help:"Bring the database schema up to this build; serve also does on start."`
	Serve       serveCmd       `cmd:"" help:"HTTP API and the default job queue; logs JSON to stderr at BANK_LOG_LEVEL (default info)."`
	Worker      workerCmd      `cmd:"" help:"Work one job queue, such as ocr, beside a running serve."`
	UI          uiCmd          `cmd:"" name:"ui" help:"Local archive browser (needs BANK_URL)."`
	Token       tokenCmd       `cmd:"" help:"API tokens."`
	Disk        diskcmd.Cmd    `cmd:"" help:"Scan, verify, copy and tidy files on the disks attached to this machine."`
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

// newCLI builds the command tree, with one import command per registered
// kind.
func newCLI() *cli {
	return &cli{Import: importCmd{Kinds: sources.All.Commands(runImport)}}
}

func newParser(root *cli) *kong.Kong {
	return kong.Must(root,
		kong.Name("bank"),
		kong.Description(description),
		kong.Vars{"version": buildVersion(), "limit": strconv.Itoa(page.DefaultLimit),
			"max_limit": strconv.Itoa(page.MaxLimit), "max_offset": strconv.Itoa(page.MaxOffset)},
		kong.WithHyphenPrefixedParameters(true),
	)
}

func execute(ctx context.Context, args []string) error {
	kctx, err := newParser(newCLI()).Parse(args)
	if err != nil {
		return err
	}
	kctx.BindTo(ctx, (*context.Context)(nil))
	kctx.Bind(diskcmd.Connect(connect))
	return kctx.Run()
}

func printUsage(w io.Writer) {
	parser := newParser(newCLI())
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

func databaseURL() string {
	return cmp.Or(os.Getenv("DATABASE_URL"), db.DefaultURL)
}

// localDB is the archive and the file catalogue on one pool, for the API
// served in process and the commands that work on the box itself.
type localDB struct {
	*store.Store
	catalogue *attic.Catalogue
	pool      *pgxpool.Pool
}

func (l *localDB) Close() {
	l.CloseQuery()
	l.pool.Close()
}

func openStore(ctx context.Context) (*localDB, error) {
	pool, err := db.Open(ctx, databaseURL())
	if err != nil {
		return nil, err
	}
	l := &localDB{Store: store.New(pool), catalogue: attic.New(atticstore.New(pool), filepath.Join(dataDir(), "scans")), pool: pool}
	if queryURL := os.Getenv("BANK_QUERY_DATABASE_URL"); queryURL != "" {
		if err := l.ConfigureQuery(ctx, queryURL); err != nil {
			l.Close()
			return nil, err
		}
	}
	return l, nil
}

// openLocal is openStore plus the blob store and the registered kinds.
func openLocal(ctx context.Context) (*importer.Target, func(), error) {
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	return &importer.Target{Store: st.Store, Blobs: blobs, Kinds: sources.All}, st.Close, nil
}

// connect returns the API: a `bank serve` at BANK_URL, or the same handler
// served in this process from DATABASE_URL and BANK_DATA_DIR. In process it
// runs no jobs and listens on nothing; close releases the database.
func connect(ctx context.Context) (*client.Client, func(), error) {
	if remote := client.FromEnv(); remote != nil {
		return remote, func() {}, nil
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, nil, err
	}
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	srv := server.New(st.Store, st.catalogue, blobs, dataDir(), sources.All)
	return client.InProcess(srv.LocalHandler()), func() {
		if err := st.catalogue.Close(); err != nil {
			fmt.Fprintln(os.Stderr, "bank:", err)
		}
		st.Close()
	}, nil
}

// onTheBox refuses a command that works on the archive's own database, blob
// store or token file when BANK_URL says this machine is a client: acting on
// the wrong box is the split brain the API exists to prevent.
func onTheBox(command, reason string) error {
	if client.FromEnv() != nil {
		return fmt.Errorf("%s %s; run it on the server, not through BANK_URL", command, reason)
	}
	return nil
}

func pageOf(limit, offset int) httpapi.Page {
	return httpapi.Page{PageSize: httpapi.PageSize{Limit: limit}, Offset: offset}
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
	if err := onTheBox("sync", "reads the OAuth token beside the blob store and writes rows, blobs and raw mail together"); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	res, err := gmail.Sync(ctx, *d, dataDir(), c.Full)
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
	Query         []string    `arg:"" optional:"" help:"Words and \"quoted phrases\"; without them, browse filtered conversations."`
	Kind          string      `help:"message, item, activity, collection, file, page, or media subtype."`
	Account       string      `help:"Filter library records by source account."`
	Source        string      `help:"Filter by source (whatsapp, gmail, ...)."`
	Thread        string      `help:"Only messages in this thread."`
	From          string      `help:"Sender has these words; when browsing, contains this text."`
	To            string      `help:"A recipient has these words; when browsing, contains this text."`
	Person        string      `help:"Filter by contact, across all their aliases."`
	MailboxID     int64       `help:"Observed folder id from bank mail mailboxes; requires --source."`
	Subject       string      `help:"Subject contains this literal text, case-insensitive."`
	HasAttachment string      `help:"true or false."`
	Any           bool        `help:"Match any word or phrase instead of every one."`
	Since         string      `help:"YYYY-MM-DD or RFC 3339."`
	Until         string      `help:"YYYY-MM-DD or RFC 3339 (exclusive)."`
	Limit         int         `default:"${limit}" help:"Max results, 1-${max_limit}."`
	Offset        int         `help:"Skip this many ranked results, for the next page (max ${max_offset})."`
	After         ref.Message `help:"When browsing, continue after this thread: the last ref of the previous page."`
	JSON          bool        `help:"JSON output."`
}

func (c *searchCmd) Run(ctx context.Context) error {
	query := strings.Join(c.Query, " ")
	if query == "" && (c.Kind != "" || c.Account != "") {
		return fmt.Errorf("kind/account require a search query; use bank library list to browse library records")
	}
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	if query == "" {
		if c.Offset > 0 {
			return fmt.Errorf("browsing pages with --after, not --offset")
		}
		groups, err := client.Call(ctx, api, server.ListThreads, server.ListThreadsInput{Source: c.Source, From: c.From, To: c.To,
			Person: c.Person, Subject: c.Subject, Since: c.Since, Until: c.Until, MailboxID: c.MailboxID,
			HasAttachment: c.HasAttachment, After: c.After, PageSize: httpapi.PageSize{Limit: c.Limit}})
		if err != nil {
			return err
		}
		if c.JSON {
			return printJSON(groups)
		}
		for _, group := range groups {
			fmt.Printf("%s  %s  %-12s  %d matching messages  %s\n", group.LastRef, formatSent(group.LastAt, "2006-01-02"), group.Source, group.Count, group.Subject)
		}
		if len(groups) == c.Limit {
			fmt.Printf("\n… possibly more: repeat with --after %s\n", groups[len(groups)-1].LastRef)
		}
		return nil
	}
	match := ""
	if c.Any {
		match = "any"
	}
	result, err := client.Call(ctx, api, server.Search, server.SearchInput{Q: query, Match: match, Kind: c.Kind,
		Source: c.Source, Account: c.Account, Since: c.Since, Until: c.Until, Thread: c.Thread, From: c.From, To: c.To,
		Person: c.Person, Subject: c.Subject, MailboxID: c.MailboxID, HasAttachment: c.HasAttachment,
		Page: pageOf(c.Limit, c.Offset)})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(result)
	}
	return printCatalog(result, c.Limit, c.Offset)
}

// printMorePages says how to reach the next page. A full page is the signal
// that there may be more — the same rule a --json caller uses, since a short
// page means the end.
func printMorePages(got, limit, offset int) {
	if got < limit {
		return
	}
	next := offset + limit
	if next > page.MaxOffset {
		fmt.Printf("\n… possibly more, but past the --offset %d cap; narrow the query instead\n", page.MaxOffset)
		return
	}
	fmt.Printf("\n… possibly more: repeat with --offset %d\n", next)
}

type threadCmd struct {
	ID      []string    `arg:"" help:"Thread id; several words are joined with spaces."`
	Source  string      `help:"Source the thread belongs to."`
	Limit   int         `default:"${limit}" help:"Page size, 1-${max_limit}."`
	Before  ref.Message `help:"Page backward from this message, by ref."`
	After   ref.Message `help:"Page forward from this message, by ref."`
	Around  ref.Message `help:"Center context on this message, by ref."`
	Latest  bool        `help:"Start at the newest page."`
	Current bool        `help:"Read a current subgroup instead of resolving its historical alias."`
	JSON    bool        `help:"JSON output, including has_before, has_after and attachments."`
}

func (c *threadCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	thread, err := client.Call(ctx, api, server.GetThread, server.ThreadInput{ID: strings.Join(c.ID, " "), Source: c.Source,
		Before: c.Before, After: c.After, Around: c.Around, Latest: c.Latest, Current: c.Current, PageSize: httpapi.PageSize{Limit: c.Limit}})
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
		fmt.Printf("[%s] %s  %s\n", m.Ref, formatSent(m.SentAt, "2006-01-02 15:04"), m.Sender)
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
			fmt.Printf("Earlier messages: --before %s\n", thread.Messages[0].Ref)
		}
		if thread.HasAfter {
			fmt.Printf("Later messages: --after %s\n", thread.Messages[len(thread.Messages)-1].Ref)
		}
	}
	return nil
}

type showCmd struct {
	Ref        ref.Ref `arg:"" help:"The ref as cited: msg:<16 hex>, content:<16 to 64 hex>, or a library ID such as item:<32 hex>."`
	JSON       bool    `help:"JSON output: what the ref names, its links, and the whole record under record."`
	Provenance bool    `help:"For a message: archive, folder, and mail grouping evidence."`
	Text       bool    `help:"For a content: print the text read from it, by a disk scan, a text job or by hand."`
	Metadata   bool    `help:"For a content: print its embedded image, document, audio and video tags."`
}

func (c *showCmd) Validate() error {
	kind := c.Ref.Kind()
	switch {
	case (c.Text || c.Metadata) && kind != ref.KindContent:
		return fmt.Errorf("--text and --metadata need a content ref")
	case c.Text && c.Metadata:
		return fmt.Errorf("--text and --metadata cannot be combined")
	case c.Provenance && kind != ref.KindMessage:
		return fmt.Errorf("--provenance needs a message ref")
	}
	return nil
}

// shown is what `bank show --json` prints: what the ref names and where the
// same bytes are, with the record itself.
type shown[T any] struct {
	catalog.Resolved
	Record T `json:"record"`
}

func (c *showCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	if c.Text || c.Metadata {
		cited, err := c.Ref.Content()
		if err != nil {
			return err
		}
		return showContentPart(ctx, api, cited, c.Text, c.JSON)
	}
	resolved, err := client.Call(ctx, api, server.ResolveRef, server.ResolveInput{Ref: c.Ref})
	if err != nil {
		return err
	}
	switch c.Ref.Kind() {
	case ref.KindMessage:
		return c.showMessage(ctx, api, resolved)
	case ref.KindContent:
		cited, err := c.Ref.Content()
		if err != nil {
			return err
		}
		found, err := diskcmd.Content(ctx, api, cited)
		if err != nil {
			return err
		}
		if c.JSON {
			return printJSON(shown[view.Content]{resolved, found})
		}
		fmt.Printf("%s  %s, first seen %s\n  blake3  %s\n", found.Ref, humanBytes(found.Size), found.FirstSeen.Local().Format("2006-01-02"), found.BLAKE3)
		printLinks(resolved, "on_disk")
		if len(found.Occurrences) > 0 {
			fmt.Println("on disks:")
		}
		return diskcmd.PrintPlaces(found)
	case ref.KindItem:
		return showLibrary(ctx, api, server.GetLibraryItem, c.Ref, resolved, c.JSON)
	case ref.KindActivity:
		return showLibrary(ctx, api, server.GetLibraryActivity, c.Ref, resolved, c.JSON)
	case ref.KindCollection:
		return showLibrary(ctx, api, server.GetLibraryCollection, c.Ref, resolved, c.JSON)
	case ref.KindFile:
		return showLibrary(ctx, api, server.GetLibraryFile, c.Ref, resolved, c.JSON)
	case ref.KindPage:
		return showLibrary(ctx, api, server.GetLibraryPage, c.Ref, resolved, c.JSON)
	}
	return fmt.Errorf("%s names no kind of record bank shows", c.Ref)
}

func (c *showCmd) showMessage(ctx context.Context, api *client.Client, resolved catalog.Resolved) error {
	cited, err := c.Ref.Message()
	if err != nil {
		return err
	}
	d, err := client.Call(ctx, api, server.GetMessage, server.MessageInput{Ref: cited})
	if retired, ok := errors.AsType[*store.RetiredError](err); ok {
		if c.JSON {
			return printJSON(shown[store.RetiredMessage]{resolved, retired.Retired})
		}
		printRetired(retired.Retired)
		printLinks(resolved)
		return nil
	}
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no message %s", c.Ref)
	}
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(shown[store.MessageDetail]{resolved, d})
	}

	m := d.Message
	printReplyInfo(m)
	fmt.Printf("ref:     %s\nsource:  %s\nthread:  %s\nfrom:    %s\ndate:    %s\n",
		m.Ref, m.Source, m.ThreadID, m.Sender, formatSent(m.SentAt, time.RFC1123))
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
		for _, a := range d.Attachments {
			fmt.Printf("attachment: %s (%d bytes)  bank fetch %s\n", a.Filename, a.SizeBytes, a.BLAKE3)
			if a.TextStatus != "" {
				fmt.Printf("            text: %s", a.TextStatus)
				if a.TextChars > 0 {
					fmt.Printf(" (%s characters, searchable)", humanCount(int64(a.TextChars)))
				}
				fmt.Println()
			}
		}
	}
	printLinks(resolved, "attachment")
	return nil
}

// showLibrary prints a library record: what it is in text, and the whole
// record in JSON.
func showLibrary[T any](ctx context.Context, api *client.Client, op httpapi.Op[server.LibraryIDInput, T], cited ref.Ref, resolved catalog.Resolved, asJSON bool) error {
	record, err := client.Call(ctx, api, op, server.LibraryIDInput{ID: cited.String()})
	if err != nil {
		return err
	}
	if asJSON {
		return printJSON(shown[T]{resolved, record})
	}
	fmt.Printf("%s  %s  %s\n  full  %s\n", resolved.Kind, resolved.Ref, resolved.Title, resolved.Href)
	printLinks(resolved)
	return nil
}

// showContentPart prints the text read from a content, or its embedded tags.
func showContentPart(ctx context.Context, api *client.Client, cited ref.Content, text, asJSON bool) error {
	if !text {
		d, err := diskcmd.Metadata(ctx, api, cited)
		switch {
		case err != nil:
			return err
		case asJSON:
			return printJSON(d)
		}
		return diskcmd.PrintMetadata(d)
	}
	d, err := diskcmd.Text(ctx, api, cited)
	switch {
	case err != nil:
		return err
	case asJSON:
		return printJSON(d)
	case d.Text == "":
		return fmt.Errorf("%s has no text: %s %s", d.Ref, d.Status, d.Detail)
	}
	fmt.Println(d.Text)
	return nil
}

// printLinks lists where the same bytes are elsewhere, leaving out the
// relations the record's own output already shows.
func printLinks(resolved catalog.Resolved, shownAlready ...string) {
	for _, link := range resolved.Links {
		if !slices.Contains(shownAlready, link.Relation) {
			fmt.Printf("%-11s %s  %s\n", link.Relation, link.Ref, link.Title)
		}
	}
}

func printRetired(r store.RetiredMessage) {
	replacement := r.Replacement
	if replacement == "" {
		replacement = "none recorded"
	}
	fmt.Printf("retired: %s\nsource:  %s\nexternal ID: %s\ndate:    %s\n", r.Ref, r.Source, r.ExternalID, formatSent(r.SentAt, time.RFC1123))
	if r.Subject != "" {
		fmt.Printf("subject: %s\n", r.Subject)
	}
	fmt.Printf("retired at: %s\nreason:  %s\nreplacement: %s\n", r.RetiredAt.Format(time.RFC1123), r.Reason, replacement)
	if r.RawInput != 0 {
		fmt.Printf("raw input: %d\n", r.RawInput)
	}
}

// rawInputLabel names a raw input and where in it a record was read, or
// nothing when the record came from none.
func rawInputLabel(id int64, locator string) string {
	if id == 0 {
		return ""
	}
	if locator == "" {
		return strconv.FormatInt(id, 10)
	}
	return fmt.Sprintf("%d, at %s", id, locator)
}

// formatSent prints a message date, or says the source gave none.
func formatSent(t time.Time, layout string) string {
	if t.IsZero() {
		return "undated"
	}
	return t.Format(layout)
}

func printProvenance(m store.Message) {
	recorded := func(value string) string {
		if value == "" {
			return "not recorded"
		}
		return value
	}
	fmt.Printf("external ID: %s\nraw input: %s\n", recorded(m.ExternalID), recorded(rawInputLabel(m.RawInput, m.RawLocator)))
	if len(m.Mailboxes) == 0 {
		fmt.Println("observed folders: not recorded")
	}
	for _, mailbox := range m.Mailboxes {
		fmt.Printf("observed folder: %s (%s, historical)\n", mailbox.Path, mailbox.Kind)
	}
	if mail := m.Mail; mail != nil {
		fmt.Printf("header raw input: %s\nnormalized Message-ID: %s\nIn-Reply-To: %s\nReferences: %s\nprovider thread ID: %s\nreply links: %t\ngrouping incomplete: %t\nconflict key: %s\n",
			recorded(rawInputLabel(mail.RawInput, "")), recorded(mail.MessageID), recorded(strings.Join(mail.InReplyTo, ", ")), recorded(strings.Join(mail.References, ", ")), recorded(mail.NativeThreadID), mail.HasReplyLinks, mail.Incomplete, recorded(mail.ConflictKey))
	}
}

type statsCmd struct {
	JSON bool `help:"JSON output."`
}

func (c *statsCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	stats, err := client.Call(ctx, api, server.GetStats, struct{}{})
	if err != nil {
		return err
	}
	disks, err := diskcmd.Stats(ctx, api)
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(struct {
			Sources []store.SourceStats `json:"sources"`
			Disks   view.Stats          `json:"disks"`
		}{stats, disks})
	}
	if len(stats) == 0 {
		fmt.Println("archive is empty")
	}
	var total int64
	for _, s := range stats {
		fmt.Printf("%-12s %8d messages  %s — %s  last import %s",
			s.Source, s.Messages, formatSent(s.Earliest, "2006-01-02"), formatSent(s.Latest, "2006-01-02"),
			s.LastIngest.Format("2006-01-02"))
		if s.Undated > 0 {
			fmt.Printf("  %d undated", s.Undated)
		}
		if s.LastSync != nil {
			fmt.Printf("  synced %s", s.LastSync.Format("2006-01-02 15:04"))
		}
		if s.Stale {
			fmt.Print("  (stale)")
		}
		fmt.Println()
		if s.Note != "" {
			fmt.Printf("%-12s %s\n", "", s.Note)
		}
		total += s.Messages
	}
	if len(stats) > 0 {
		fmt.Printf("%-12s %8d messages\n", "total", total)
	}
	if anyStale(stats) {
		fmt.Printf("\n(stale) means nothing new in %d days — a gap there may be a broken import, not a quiet month\n",
			int(store.StaleAfter.Hours()/24))
	}

	// Text read from attachments belongs in "how much of my archive can I
	// actually search", but not in --json: `bank attachment stats --json` is
	// its machine-readable form.
	ext, err := client.Call(ctx, api, server.GetAttachmentStats, struct{}{})
	if err != nil {
		return err
	}
	if len(ext) > 0 {
		fmt.Println()
		printExtractionStats(ext)
	}
	fmt.Println("\nfiles on disks:")
	diskcmd.PrintStats(disks)
	return nil
}

func anyStale(stats []store.SourceStats) bool {
	return slices.ContainsFunc(stats, func(s store.SourceStats) bool { return s.Stale })
}

// noteCmd maintains the per-source note on what the archive actually holds
// — the context that turns "search found nothing" into either "it did not
// happen" or "that period was never imported".
type noteCmd struct {
	Source string   `arg:""`
	Text   []string `arg:"" optional:"" help:"The note; omit it to clear."`
}

func (c *noteCmd) Run(ctx context.Context) error {
	text := strings.Join(c.Text, " ")
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	if _, err := client.Call(ctx, api, server.SetSourceNote, server.NoteInput{Source: c.Source, Body: server.NoteInputBody{Text: text}}); err != nil {
		return err
	}
	if text == "" {
		fmt.Printf("%s: note cleared\n", c.Source)
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
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	res, err := client.Call(ctx, api, server.RunQuery, server.QueryInput{Body: server.QueryInputBody{SQL: query, Limit: c.Limit}})
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
	BLAKE3 content.Digest `arg:"" name:"blake3" help:"The content's BLAKE3 digest, 64 lowercase hex characters."`
	Output string         `short:"o" help:"Destination path (default: the digest)."`
}

func (c *fetchCmd) Run(ctx context.Context) error {
	dest := c.Output
	if dest == "" {
		dest = c.BLAKE3.String()
	}

	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	src, err := client.Open(ctx, api, server.GetBlob, server.DigestInput{BLAKE3: c.BLAKE3})
	if err != nil {
		return err
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
	JSON bool `help:"JSON output."`
}

func (c *verifyCmd) Run(ctx context.Context) error {
	if err := onTheBox("verify", "reads the blob store directly"); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	rep, err := verify.Run(ctx, d.Store, d.Blobs)
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(rep)
	}
	for _, f := range rep.Findings {
		fmt.Printf("%-12s %s %s (held by %d: %s)\n", f.Kind, f.BLAKE3, f.Detail, f.Holders, strings.Join(f.Uses, ", "))
	}
	if rep.Damaged == 0 {
		fmt.Printf("%d contents checked: no damage found\n", rep.ContentsChecked)
		return nil
	}
	fmt.Printf("%d contents checked: %s\n", rep.ContentsChecked, plural(rep.Damaged, "problem"))
	if len(rep.Findings) < rep.Damaged {
		fmt.Printf("(showing the first %d findings)\n", len(rep.Findings))
	}
	return nil
}

type migrateCmd struct{}

func (migrateCmd) Run(ctx context.Context) error {
	if err := onTheBox("migrate", "changes the database directly"); err != nil {
		return err
	}
	if err := db.Migrate(ctx, databaseURL()); err != nil {
		return err
	}
	fmt.Println("database schema is up to date")
	return nil
}

type serveCmd struct {
	Listen string `default:"127.0.0.1:8480" help:"Address to listen on."`
}

func (c *serveCmd) Run(ctx context.Context) error {
	logJSON()
	if err := db.Migrate(ctx, databaseURL()); err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		return err
	}
	queue, err := worker.Serve(st.pool, workerDeps(st.Store, blobs, ""))
	if err != nil {
		return err
	}
	if listed, err := server.Tokens(dataDir()).List(); err == nil && len(listed) == 0 {
		slog.Warn("no tokens yet; every /v1 request will 401 until 'bank token new <name>'")
	}
	srv := server.New(st.Store, st.catalogue, blobs, dataDir(), sources.All)
	slog.Info("serving", "version", buildVersion(), "listen", c.Listen)
	return worker.Run(ctx, queue, server.Drain, func(ctx context.Context) error {
		return srv.ListenAndServe(ctx, c.Listen)
	})
}

func workerDeps(st *store.Store, blobs *blob.Store, ocrLang string) worker.Deps {
	return worker.Deps{
		Target:  importer.Target{Store: st, Blobs: blobs, Kinds: sources.All},
		DataDir: dataDir(), TempDir: stagingDir(), OCRLang: ocrLang,
	}
}

// workerCmd works a queue in another process: the ocr queue in the image that
// carries tesseract, which the server's image does not.
type workerCmd struct {
	Queue   string `default:"ocr" enum:"ocr,default" help:"The queue to work: ocr or default."`
	Workers int    `default:"1" help:"Jobs worked at once."`
	Lang    string `default:"eng" help:"OCR language, tesseract syntax (\"deu+eng\" for two)."`
}

func (c *workerCmd) Run(ctx context.Context) error {
	if err := onTheBox("worker", "reads blobs and writes text on the server's own box"); err != nil {
		return err
	}
	if c.Workers < 1 {
		return fmt.Errorf("--workers must be at least 1")
	}
	logJSON()
	if c.Queue == jobs.OCRQueue {
		o := extract.DefaultOptions()
		o.OCRLang = c.Lang
		if err := extract.OCRAvailable(o); err != nil {
			return err
		}
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	blobs, err := blob.New(filepath.Join(dataDir(), "blobs"))
	if err != nil {
		return err
	}
	queue, err := worker.Queue(st.pool, workerDeps(st.Store, blobs, c.Lang), c.Queue, c.Workers)
	if err != nil {
		return err
	}
	slog.Info("working", "version", buildVersion(), "queue", c.Queue, "workers", c.Workers)
	return worker.Run(ctx, queue, server.Drain, func(ctx context.Context) error {
		<-ctx.Done()
		return nil
	})
}

// logJSON sends slog's JSON to stderr at BANK_LOG_LEVEL, for the processes
// that run unattended.
func logJSON() {
	var level slog.Level
	if err := level.UnmarshalText([]byte(os.Getenv("BANK_LOG_LEVEL"))); err != nil {
		level = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})))
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
	return onTheBox("token", "writes the file the server checks on every request")
}

type tokenNewCmd struct {
	Name     string `arg:""`
	ReadOnly bool   `help:"The token reads and searches but cannot import, edit or delete."`
}

func (c *tokenNewCmd) Run() error {
	if err := refuseRemoteToken(); err != nil {
		return err
	}
	scope := tokens.Write
	if c.ReadOnly {
		scope = tokens.Read
	}
	token, err := server.Tokens(dataDir()).New(c.Name, scope)
	if err != nil {
		return err
	}
	// Only the digest is stored, so this is the one chance to copy it.
	// The directory is printed because a token written into the wrong
	// BANK_DATA_DIR is the usual reason a server keeps answering 401.
	fmt.Fprintf(os.Stderr, "token stored in %s\n", server.Tokens(dataDir()).Path)
	fmt.Println(token)
	return nil
}

type tokenListCmd struct{}

func (tokenListCmd) Run() error {
	if err := refuseRemoteToken(); err != nil {
		return err
	}
	listed, err := server.Tokens(dataDir()).List()
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "tokens in %s\n", server.Tokens(dataDir()).Path)
	for _, token := range listed {
		fmt.Printf("%s\t%s\n", token.Name, token.Scope)
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
	return server.Tokens(dataDir()).Revoke(c.Name)
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
