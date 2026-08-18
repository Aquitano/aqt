// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	// Embedded so a container without tzdata still resolves the local zone.
	// Dates typed as YYYY-MM-DD and WhatsApp export timestamps are read in
	// local time, so an image that silently fell back to UTC would shift them.
	_ "time/tzdata"

	"github.com/aquitano/aqt-bank/internal/aichat"
	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/client"
	"github.com/aquitano/aqt-bank/internal/discord"
	"github.com/aquitano/aqt-bank/internal/eml"
	"github.com/aquitano/aqt-bank/internal/generic"
	"github.com/aquitano/aqt-bank/internal/gmail"
	"github.com/aquitano/aqt-bank/internal/inbox"
	"github.com/aquitano/aqt-bank/internal/linkedin"
	"github.com/aquitano/aqt-bank/internal/server"
	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/verify"
	"github.com/aquitano/aqt-bank/internal/whatsapp"
)

const usage = `bank — personal message archive

Usage:
  bank auth gmail [--port n] [--bind addr]    authorize Gmail (loopback OAuth)
  bank sync [--full]                          pull new mail from Gmail
  bank import whatsapp <export.zip|.txt>...   WhatsApp "Export chat" files
  bank import eml [--source s] <file|dir>...  .eml files (default source: proton)
  bank import mbox [--source s] <file>...     mbox files (default source: gmail)
  bank import discord <package.zip|dir>...    Discord GDPR data package
  bank import linkedin <zip|csv|dir>...       LinkedIn data export
  bank import chatgpt <export.zip|json|dir>   ChatGPT data export
  bank import claude <export.zip|json|dir>    Claude.ai data export
  bank import claude-code <file.jsonl|dir>    Claude Code session transcripts
  bank import json [--source s] <file|->      arbitrary JSON/NDJSON messages
                                              (the escape hatch for agents; - reads stdin)
  bank import inbox [--json]                  sweep $BANK_DATA_DIR/inbox/<kind>/
  bank search <query> [flags]                 full-text search (BM25, fuzzy)
  bank thread <id> [--source s] [--limit n]   one whole conversation, oldest first
  bank contact <add|list|show|alias|...>      one person across their many identities
  bank show <id> [--json]                     print one message + attachments
  bank stats [--json]                         per-source counts, date ranges, freshness
  bank fetch <sha256> [-o path]               write an attachment to a file
  bank verify [--heal] [--source s] [--json]  check archive integrity, optionally repair
  bank serve [--listen addr]                  HTTP API (default 127.0.0.1:8480)
  bank token new <name>                       mint an API token (printed once)
  bank token list                             token names
  bank token revoke <name>                    drop a token

Search flags:
  --source s     filter by source (whatsapp, gmail, ...)
  --from name    filter by sender (substring, case-insensitive)
  --to name      filter by recipient (substring, case-insensitive)
  --person name  filter by contact, across all their aliases (bank contact)
  --since date   YYYY-MM-DD
  --until date   YYYY-MM-DD (exclusive)
  --fuzzy n      typo tolerance 0-2 (default 1)
  --limit n      max results, 1-500 (default 20)
  --json         JSON output

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
	case "import":
		err = cmdImport(ctx, os.Args[2:])
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
	case "fetch":
		err = cmdFetch(ctx, os.Args[2:])
	case "verify":
		err = cmdVerify(ctx, os.Args[2:])
	case "serve":
		err = cmdServe(ctx, os.Args[2:])
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

func cmdImport(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: bank import <inbox|whatsapp|eml|mbox|discord|linkedin|chatgpt|claude|claude-code|json> <path>...")
	}
	kind := args[0]
	if kind == "inbox" {
		return cmdImportInbox(ctx, args[1:])
	}
	fs := flag.NewFlagSet("import "+kind, flag.ExitOnError)
	source := fs.String("source", defaultSource(kind), "")
	if err := parseFlagsAnywhere(fs, args[1:]); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("usage: bank import %s <path>...", kind)
	}
	if *source != "" {
		if err := archive.ValidSource(*source); err != nil {
			return err
		}
	}
	if c := client.FromEnv(); c != nil {
		return importRemote(ctx, c, kind, *source, fs.Args())
	}

	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	for _, path := range fs.Args() {
		res, err := importLocal(ctx, d, kind, *source, path)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		printImportResult(kind, *source, path, res)
	}
	return nil
}

func defaultSource(kind string) string {
	return map[string]string{"eml": "proton", "mbox": "gmail"}[kind]
}

// inboxSource is defaultSource for an unattended sweep, where refusing an
// entry for want of a --source would just leave the file sitting there: a JSON
// drop that names no source of its own lands under "json".
func inboxSource(kind string) string {
	if kind == "json" {
		return "json"
	}
	return defaultSource(kind)
}

// importLocal runs one importer against a local store. It is the single place
// that knows which importer owns which kind, shared by `bank import <kind>`
// and by the inbox sweep.
func importLocal(ctx context.Context, d *local, kind, source, path string) (any, error) {
	switch kind {
	case "whatsapp":
		return whatsapp.Import(ctx, d.st, d.blobs, d.archiveDir, path)
	case "eml":
		return eml.ImportEmlPath(ctx, d.st, d.blobs, d.archiveDir, source, path)
	case "mbox":
		return eml.ImportMbox(ctx, d.st, d.blobs, d.archiveDir, source, path)
	case "discord":
		return discord.Import(ctx, d.st, d.archiveDir, path)
	case "linkedin":
		return linkedin.Import(ctx, d.st, d.archiveDir, path)
	case "chatgpt":
		return aichat.ImportChatGPT(ctx, d.st, d.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, d.st, d.archiveDir, path)
	case "claude-code":
		return aichat.ImportClaudeCode(ctx, d.st, d.archiveDir, path)
	case "json":
		input, err := readInput(path)
		if err != nil {
			return nil, err
		}
		rawRef, err := archiveJSON(d.archiveDir, path, input)
		if err != nil {
			return nil, err
		}
		return generic.Import(ctx, d.st, d.blobs, source, rawRef, input, time.Now(), true)
	}
	return nil, fmt.Errorf("unknown import source %q (%s)", kind, strings.Join(inbox.Kinds, ", "))
}

func archiveJSON(archiveDir, path string, input []byte) (string, error) {
	if path == "-" {
		sum := sha256.Sum256(input)
		return archive.Write(archiveDir, "json", fmt.Sprintf("stdin-%x.json", sum[:6]), input)
	}
	return archive.Copy(archiveDir, "json", path)
}

func cmdImportInbox(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("import inbox", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if client.FromEnv() != nil {
		return fmt.Errorf("import inbox reads the server's own drop zone; run it there, not through BANK_URL")
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	inboxDir := filepath.Join(dataDir(), "inbox")
	res, sweepErr := inbox.Sweep(ctx, inboxDir, func(ctx context.Context, kind, path string) (inbox.Outcome, error) {
		out, err := importLocal(ctx, d, kind, inboxSource(kind), path)
		if err != nil {
			return inbox.Outcome{}, err
		}
		return importOutcome(out), nil
	})
	if *asJSON {
		if err := printJSON(res); err != nil {
			return err
		}
		return sweepErr
	}
	if len(res.Files) == 0 {
		fmt.Printf("inbox is empty (%s/<%s>/)\n", inboxDir, strings.Join(inbox.Kinds, "|"))
		return sweepErr
	}
	for _, f := range res.Files {
		fmt.Printf("%-10s %-9s %s", f.Kind, f.Disposition, filepath.Base(f.Path))
		if f.Detail != "" {
			fmt.Printf("  (%s)", f.Detail)
		}
		fmt.Println()
	}
	fmt.Printf("%d imported, %d already known, %d rejected, %d failed\n",
		res.Imported, res.Duplicates, res.Rejected, res.Failed)
	return sweepErr
}

// importOutcome reduces an importer's result to the counts the sweep uses to
// pick a disposition.
func importOutcome(res any) inbox.Outcome {
	switch r := res.(type) {
	case eml.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: r.Rejected, Result: r}
	case whatsapp.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case discord.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: len(r.FailedChannels), Result: r}
	case linkedin.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Result: r}
	case aichat.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: len(r.FailedSessions), Result: r}
	case generic.Result:
		return inbox.Outcome{Inserted: r.Inserted, Duplicates: r.Duplicates, Rejected: r.Rejected, Result: r}
	}
	return inbox.Outcome{Result: res}
}

func printImportResult(kind, source, path string, res any) {
	switch r := res.(type) {
	case eml.Result:
		printEmlResult(source, path, r)
	case whatsapp.Result:
		printWhatsAppResult(r)
	case discord.Result:
		printDiscordResult(r)
	case linkedin.Result:
		printLinkedInResult(r)
	case aichat.Result:
		printAIChatResult(kind, r)
	case generic.Result:
		printGenericResult(r)
	}
}

func printEmlResult(source, path string, res eml.Result) {
	fmt.Printf("%s (%s): %d new, %d already known, %d attachments", source, filepath.Base(path), res.Inserted, res.Duplicates, res.Attachments)
	if res.Healed > 0 {
		fmt.Printf(" (%d recovered)", res.Healed)
	}
	if res.Rejected > 0 {
		fmt.Printf(", %d rejected as malformed", res.Rejected)
	}
	if res.Damaged > 0 {
		fmt.Printf(", %d with damaged MIME structure", res.Damaged)
	}
	fmt.Println()
	for _, w := range res.Warnings {
		fmt.Fprintf(os.Stderr, "bank: %s\n", w)
	}
}

func printWhatsAppResult(res whatsapp.Result) {
	fmt.Printf("%s: %d new, %d already known, %d attachments", res.Thread, res.Inserted, res.Duplicates, res.Attachments)
	if res.MissingMedia > 0 {
		fmt.Printf(", %d media files referenced but not in export", res.MissingMedia)
	}
	fmt.Println()
}

func printDiscordResult(res discord.Result) {
	fmt.Printf("discord: %d channels, %d new, %d already known, %d empty rows skipped",
		res.Channels, res.Inserted, res.Duplicates, res.Skipped)
	if len(res.FailedChannels) > 0 {
		fmt.Printf(", %d channels unreadable (%s)", len(res.FailedChannels), strings.Join(res.FailedChannels, ", "))
	}
	fmt.Println()
}

func printLinkedInResult(res linkedin.Result) {
	fmt.Printf("linkedin: %d new, %d already known, %d empty rows skipped\n",
		res.Inserted, res.Duplicates, res.Skipped)
}

func printAIChatResult(kind string, res aichat.Result) {
	fmt.Printf("%s: %d conversations, %d new, %d already known, %d empty skipped",
		kind, res.Conversations, res.Inserted, res.Duplicates, res.Skipped)
	if len(res.FailedSessions) > 0 {
		fmt.Printf(", %d sessions unreadable", len(res.FailedSessions))
	}
	fmt.Println()
	for _, p := range res.FailedSessions {
		fmt.Fprintf(os.Stderr, "bank: unreadable session: %s\n", p)
	}
}

func printGenericResult(res generic.Result) {
	fmt.Printf("json: %d new, %d already known, %d attachments", res.Inserted, res.Duplicates, res.Attachments)
	if res.Healed > 0 {
		fmt.Printf(" (%d recovered)", res.Healed)
	}
	if res.Rejected > 0 {
		fmt.Printf(", %d entries rejected", res.Rejected)
	}
	fmt.Println()
}

// importRemote uploads to a `bank serve`. The server only ever sees single
// files, so directory inputs are expanded here.
func importRemote(ctx context.Context, c *client.Client, kind, source string, paths []string) error {
	for _, path := range paths {
		if kind == "json" {
			input, err := readInput(path)
			if err != nil {
				return err
			}
			res, err := c.ImportJSON(ctx, source, input)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			printGenericResult(res)
			continue
		}
		files, err := remoteImportFiles(kind, path)
		if err != nil {
			return err
		}
		for _, f := range files {
			if err := importRemoteFile(ctx, c, kind, source, f); err != nil {
				return fmt.Errorf("%s: %w", f, err)
			}
		}
	}
	return nil
}

func remoteImportFiles(kind, path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return []string{path}, nil
	}
	ext := map[string]string{"eml": ".eml", "claude-code": ".jsonl"}[kind]
	if ext == "" {
		return nil, fmt.Errorf("%s: remote import of %s takes a file, not a directory", path, kind)
	}
	var out []string
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ext) {
			return err
		}
		out = append(out, p)
		return nil
	})
	return out, err
}

func importRemoteFile(ctx context.Context, c *client.Client, kind, source, path string) error {
	switch kind {
	case "whatsapp":
		res, err := client.ImportFile[whatsapp.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printWhatsAppResult(res)
	case "eml", "mbox":
		res, err := client.ImportFile[eml.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printEmlResult(source, path, res)
	case "discord":
		res, err := client.ImportFile[discord.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printDiscordResult(res)
	case "linkedin":
		res, err := client.ImportFile[linkedin.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printLinkedInResult(res)
	case "chatgpt", "claude", "claude-code":
		res, err := client.ImportFile[aichat.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printAIChatResult(kind, res)
	default:
		return fmt.Errorf("unknown import source %q (%s)", kind, strings.Join(inbox.Kinds, ", "))
	}
	return nil
}

// readInput reads a file, or stdin when path is "-".
func readInput(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
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
	fs.StringVar(&since, "since", "", "")
	fs.StringVar(&until, "until", "", "")
	fs.IntVar(&o.Fuzzy, "fuzzy", 1, "")
	fs.IntVar(&o.Limit, "limit", 20, "")
	fs.BoolVar(&asJSON, "json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	query := strings.Join(fs.Args(), " ")
	if query == "" {
		return fmt.Errorf("usage: bank search <query> [flags]")
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

	msgs, err := searchMessages(ctx, query, o)
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
	}
	return nil
}

func cmdThread(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("thread", flag.ExitOnError)
	source := fs.String("source", "", "")
	limit := fs.Int("limit", 0, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("usage: bank thread <id> [--source s] [--limit n] [--json]")
	}
	threadID := strings.Join(fs.Args(), " ")

	var thread store.Thread
	var err error
	if c := client.FromEnv(); c != nil {
		thread, err = c.Thread(ctx, *source, threadID, *limit)
	} else {
		var st *store.Store
		if st, err = openStore(ctx); err == nil {
			defer st.Close()
			thread, err = st.GetThread(ctx, *source, threadID, *limit)
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no thread %q", threadID)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(thread)
	}
	fmt.Printf("thread:  %s\nsource:  %s\nmessages: %d\n\n", thread.ThreadID, thread.Source, len(thread.Messages))
	for _, m := range thread.Messages {
		fmt.Printf("[%d] %s  %s\n", m.ID, m.SentAt.Format("2006-01-02 15:04"), m.Sender)
		if m.Subject != "" {
			fmt.Printf("    %s\n", m.Subject)
		}
		for _, line := range strings.Split(strings.TrimSpace(m.Body), "\n") {
			fmt.Printf("    %s\n", line)
		}
		fmt.Println()
	}
	if thread.Truncated {
		fmt.Printf("… truncated at %d messages; raise --limit (max %d)\n", len(thread.Messages), store.MaxThreadMessages)
	}
	return nil
}

func cmdShow(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank show <id> [--json]")
	}
	id, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if err != nil {
		return fmt.Errorf("invalid id %q", fs.Arg(0))
	}

	remote := client.FromEnv() != nil
	d, err := getMessage(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no message %d", id)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(d)
	}

	m := d.Message
	fmt.Printf("id:      %d\nsource:  %s\nthread:  %s\nfrom:    %s\ndate:    %s\n",
		m.ID, m.Source, m.ThreadID, m.Sender, m.SentAt.Format(time.RFC1123))
	if len(m.Recipients) > 0 {
		fmt.Printf("to:      %s\n", strings.Join(m.Recipients, ", "))
	}
	if m.Subject != "" {
		fmt.Printf("subject: %s\n", m.Subject)
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
		}
	}
	return nil
}

func searchMessages(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error) {
	if c := client.FromEnv(); c != nil {
		return c.Search(ctx, query, o)
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, err
	}
	defer st.Close()
	return st.Search(ctx, query, o)
}

func getMessage(ctx context.Context, id int64) (store.MessageDetail, error) {
	if c := client.FromEnv(); c != nil {
		return c.Message(ctx, id)
	}
	st, err := openStore(ctx)
	if err != nil {
		return store.MessageDetail{}, err
	}
	defer st.Close()
	m, atts, err := st.GetMessage(ctx, id)
	return store.MessageDetail{Message: m, Attachments: atts}, err
}

func getStats(ctx context.Context) ([]store.SourceStats, error) {
	if c := client.FromEnv(); c != nil {
		return c.Stats(ctx)
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, err
	}
	defer st.Close()
	return st.Stats(ctx)
}

func cmdStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	stats, err := getStats(ctx)
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
		fmt.Println()
		total += s.Messages
	}
	fmt.Printf("%-12s %8d messages\n", "total", total)
	return nil
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

func cmdToken(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: bank token <new|list|revoke> [name]")
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

// contact commands: one person, many source-specific identities.

// builtinSources are the source names the importers write. Listing them means
// an alias can be scoped to a source before anything from it exists, and that
// "whatsapp:Alice" is read as a scope rather than as a name with a colon in it.
var builtinSources = []string{
	"whatsapp", "gmail", "proton", "discord", "linkedin", "chatgpt", "claude", "claude-code",
}

// contactBackend is the contact API, implemented once against Postgres and
// once against a remote `bank serve`, so every subcommand works either way.
type contactBackend interface {
	create(ctx context.Context, name, note string) (store.Contact, error)
	remove(ctx context.Context, name string) error
	list(ctx context.Context) ([]store.Contact, error)
	show(ctx context.Context, name string) (client.ContactDetail, error)
	addAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error)
	removeAlias(ctx context.Context, name, source, value string) error
	messages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.Message, error)
	suggest(ctx context.Context, limit int) ([]store.IdentitySuggestion, error)
	sources(ctx context.Context) ([]store.SourceStats, error)
	close()
}

type localContacts struct{ st *store.Store }

func (l localContacts) create(ctx context.Context, name, note string) (store.Contact, error) {
	return l.st.CreateContact(ctx, name, note)
}
func (l localContacts) remove(ctx context.Context, name string) error {
	return l.st.DeleteContact(ctx, name)
}
func (l localContacts) list(ctx context.Context) ([]store.Contact, error) {
	return l.st.ListContacts(ctx)
}
func (l localContacts) show(ctx context.Context, name string) (client.ContactDetail, error) {
	c, err := l.st.GetContact(ctx, name)
	if err != nil {
		return client.ContactDetail{}, err
	}
	counts, err := l.st.ContactSourceCounts(ctx, c.ID)
	return client.ContactDetail{Contact: c, Sources: counts}, err
}
func (l localContacts) addAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error) {
	return l.st.AddAlias(ctx, name, source, value)
}
func (l localContacts) removeAlias(ctx context.Context, name, source, value string) error {
	return l.st.RemoveAlias(ctx, name, source, value)
}
func (l localContacts) messages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.Message, error) {
	return l.st.ContactMessages(ctx, name, o)
}
func (l localContacts) suggest(ctx context.Context, limit int) ([]store.IdentitySuggestion, error) {
	return l.st.SuggestIdentities(ctx, limit)
}
func (l localContacts) sources(ctx context.Context) ([]store.SourceStats, error) {
	return l.st.Stats(ctx)
}
func (l localContacts) close() { l.st.Close() }

type remoteContacts struct{ c *client.Client }

func (r remoteContacts) create(ctx context.Context, name, note string) (store.Contact, error) {
	return r.c.CreateContact(ctx, name, note)
}
func (r remoteContacts) remove(ctx context.Context, name string) error {
	return r.c.DeleteContact(ctx, name)
}
func (r remoteContacts) list(ctx context.Context) ([]store.Contact, error) {
	return r.c.ListContacts(ctx)
}
func (r remoteContacts) show(ctx context.Context, name string) (client.ContactDetail, error) {
	return r.c.Contact(ctx, name)
}
func (r remoteContacts) addAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error) {
	return r.c.AddAlias(ctx, name, source, value)
}
func (r remoteContacts) removeAlias(ctx context.Context, name, source, value string) error {
	return r.c.RemoveAlias(ctx, name, source, value)
}
func (r remoteContacts) messages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.Message, error) {
	return r.c.ContactMessages(ctx, name, o)
}
func (r remoteContacts) suggest(ctx context.Context, limit int) ([]store.IdentitySuggestion, error) {
	return r.c.SuggestIdentities(ctx, limit)
}
func (r remoteContacts) sources(ctx context.Context) ([]store.SourceStats, error) {
	return r.c.Stats(ctx)
}
func (r remoteContacts) close() {}

func openContacts(ctx context.Context) (contactBackend, error) {
	if c := client.FromEnv(); c != nil {
		return remoteContacts{c: c}, nil
	}
	st, err := openStore(ctx)
	if err != nil {
		return nil, err
	}
	return localContacts{st: st}, nil
}

const contactUsage = `usage: bank contact <add|rm|list|show|alias|messages|suggest> ...

  bank contact add <name> [--note text]
  bank contact rm <name>
  bank contact list [--json]
  bank contact show <name> [--json]
  bank contact alias add <name> <alias>...
  bank contact alias rm <name> <alias>...
  bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--json]
  bank contact suggest [--limit n] [--json]

An alias is an identity that means this person: an email address, a WhatsApp
display name, a Discord handle. It matches everywhere by default; write it as
"<source>:<value>" to bind it to one source.`

func cmdContact(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(contactUsage)
	}
	b, err := openContacts(ctx)
	if err != nil {
		return err
	}
	defer b.close()

	switch args[0] {
	case "add":
		return contactAdd(ctx, b, args[1:])
	case "rm", "remove", "delete":
		return contactRemove(ctx, b, args[1:])
	case "list", "ls":
		return contactList(ctx, b, args[1:])
	case "show":
		return contactShow(ctx, b, args[1:])
	case "alias":
		return contactAlias(ctx, b, args[1:])
	case "messages":
		return contactMessages(ctx, b, args[1:])
	case "suggest":
		return contactSuggest(ctx, b, args[1:])
	}
	return fmt.Errorf("unknown contact command %q\n\n%s", args[0], contactUsage)
}

func contactAdd(ctx context.Context, b contactBackend, args []string) error {
	fs := flag.NewFlagSet("contact add", flag.ExitOnError)
	note := fs.String("note", "", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact add <name> [--note text]")
	}
	c, err := b.create(ctx, fs.Arg(0), *note)
	if err != nil {
		return err
	}
	fmt.Printf("contact %s\nattach identities with: bank contact alias add %s <email|handle>\n", c.Name, c.Name)
	return nil
}

func contactRemove(ctx context.Context, b contactBackend, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: bank contact rm <name>")
	}
	if err := b.remove(ctx, args[0]); err != nil {
		return contactErr(args[0], err)
	}
	// Worth saying plainly: this is a lens, not the data.
	fmt.Printf("contact %s removed; its messages are untouched\n", args[0])
	return nil
}

func contactList(ctx context.Context, b contactBackend, args []string) error {
	fs := flag.NewFlagSet("contact list", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	contacts, err := b.list(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(contacts)
	}
	if len(contacts) == 0 {
		fmt.Println("no contacts yet — 'bank contact suggest' shows who is in the archive")
		return nil
	}
	for _, c := range contacts {
		fmt.Printf("%-20s %s\n", c.Name, strings.Join(aliasStrings(c.Aliases), ", "))
		if c.Note != "" {
			fmt.Printf("%-20s %s\n", "", c.Note)
		}
	}
	return nil
}

func aliasStrings(aliases []store.ContactAlias) []string {
	out := make([]string, len(aliases))
	for i, a := range aliases {
		out[i] = a.Normalized
		if a.Source != "" {
			out[i] = a.Source + ":" + a.Normalized
		}
	}
	return out
}

func contactShow(ctx context.Context, b contactBackend, args []string) error {
	fs := flag.NewFlagSet("contact show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact show <name> [--json]")
	}
	d, err := b.show(ctx, fs.Arg(0))
	if err != nil {
		return contactErr(fs.Arg(0), err)
	}
	if *asJSON {
		return printJSON(d)
	}
	fmt.Printf("contact: %s\n", d.Name)
	if d.Note != "" {
		fmt.Printf("note:    %s\n", d.Note)
	}
	fmt.Println("aliases:")
	for _, a := range d.Aliases {
		fmt.Printf("  %-28s %s\n", a.Normalized, scopeLabel(a.Source))
	}
	if len(d.Aliases) == 0 {
		fmt.Println("  (none yet — nothing will match until one is attached)")
	}
	var total int64
	fmt.Println("messages:")
	for _, s := range d.Sources {
		fmt.Printf("  %-12s %8d\n", s.Source, s.Messages)
		total += s.Messages
	}
	fmt.Printf("  %-12s %8d\n", "total", total)
	return nil
}

func scopeLabel(source string) string {
	if source == "" {
		return "(all sources)"
	}
	return "(" + source + " only)"
}

func contactAlias(ctx context.Context, b contactBackend, args []string) error {
	if len(args) < 3 {
		return errors.New("usage: bank contact alias <add|rm> <name> <alias>...")
	}
	action, name, aliases := args[0], args[1], args[2:]
	known, err := knownSources(ctx, b)
	if err != nil {
		return err
	}
	for _, raw := range aliases {
		source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
		switch action {
		case "add":
			a, err := b.addAlias(ctx, name, source, value)
			if err != nil {
				return contactErr(name, err)
			}
			fmt.Printf("%s: %s %s\n", name, a.Normalized, scopeLabel(a.Source))
		case "rm", "remove":
			if err := b.removeAlias(ctx, name, source, value); err != nil {
				return contactErr(name, err)
			}
			fmt.Printf("%s: detached %s %s\n", name, value, scopeLabel(source))
		default:
			return fmt.Errorf("unknown alias command %q (add, rm)", action)
		}
	}
	return nil
}

// knownSources is what makes "whatsapp:Alice" a scope rather than a value: the
// sources already in the archive, plus the ones importers can still create.
func knownSources(ctx context.Context, b contactBackend) (map[string]bool, error) {
	out := map[string]bool{}
	for _, s := range builtinSources {
		out[s] = true
	}
	stats, err := b.sources(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range stats {
		out[s.Source] = true
	}
	return out, nil
}

func contactMessages(ctx context.Context, b contactBackend, args []string) error {
	fs := flag.NewFlagSet("contact messages", flag.ExitOnError)
	var o store.ContactMessagesOpts
	var since, until string
	var asJSON bool
	fs.StringVar(&o.Source, "source", "", "")
	fs.StringVar(&since, "since", "", "")
	fs.StringVar(&until, "until", "", "")
	fs.IntVar(&o.Limit, "limit", 50, "")
	fs.BoolVar(&asJSON, "json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact messages <name> [flags]")
	}
	var err error
	if o.Since, err = parseDate(since); err != nil {
		return err
	}
	if o.Until, err = parseDate(until); err != nil {
		return err
	}
	msgs, err := b.messages(ctx, fs.Arg(0), o)
	if err != nil {
		return contactErr(fs.Arg(0), err)
	}
	if asJSON {
		return printJSON(msgs)
	}
	if len(msgs) == 0 {
		fmt.Println("no messages — check 'bank contact show' that an alias actually matches")
		return nil
	}
	for _, m := range msgs {
		title := m.Subject
		if title == "" {
			title = excerpt(m.Body, 100)
		}
		fmt.Printf("%6d  %s  %-8s  %-22s  %s\n",
			m.ID, m.SentAt.Format("2006-01-02"), m.Source, excerpt(m.Sender, 22), title)
	}
	return nil
}

func contactSuggest(ctx context.Context, b contactBackend, args []string) error {
	fs := flag.NewFlagSet("contact suggest", flag.ExitOnError)
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	out, err := b.suggest(ctx, *limit)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(out)
	}
	if len(out) == 0 {
		fmt.Println("every identity in the archive is already attached to a contact")
		return nil
	}
	fmt.Println("identities no contact claims yet, most talkative first:")
	for _, s := range out {
		fmt.Printf("%8d  %-40s %s\n", s.Messages, excerpt(s.Identity, 40), strings.Join(s.Sources, ", "))
	}
	fmt.Println("\nattach one with: bank contact alias add <name> <identity>")
	return nil
}

// contactErr turns the store's not-found sentinel into a message that names
// what was actually missing.
func contactErr(name string, err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no contact %q — see 'bank contact list'", name)
	}
	return err
}
