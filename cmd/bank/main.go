// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/aichat"
	"github.com/aquitano/aqt-bank/internal/archive"
	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/discord"
	"github.com/aquitano/aqt-bank/internal/eml"
	"github.com/aquitano/aqt-bank/internal/generic"
	"github.com/aquitano/aqt-bank/internal/gmail"
	"github.com/aquitano/aqt-bank/internal/linkedin"
	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/whatsapp"
)

const usage = `bank — personal message archive

Usage:
  bank auth gmail [--port n]                  authorize Gmail (loopback OAuth)
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
  bank search <query> [flags]                 full-text search (BM25, fuzzy)
  bank show <id> [--json]                     print one message + attachments
  bank stats [--json]                         per-source counts and date ranges

Search flags:
  --source s     filter by source (whatsapp, gmail, ...)
  --from name    filter by sender (substring)
  --since date   YYYY-MM-DD
  --until date   YYYY-MM-DD (exclusive)
  --fuzzy n      typo tolerance 0-2 (default 1)
  --limit n      max results (default 20)
  --json         JSON output

Environment:
  DATABASE_URL   default postgres://bank:bank@localhost:5433/bank
  BANK_DATA_DIR  default ~/.local/share/aqt-bank (blobs/, archive/, inbox/)
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
	case "show":
		err = cmdShow(ctx, os.Args[2:])
	case "stats":
		err = cmdStats(ctx, os.Args[2:])
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

func cmdAuth(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("auth", flag.ExitOnError)
	port := fs.Int("port", 0, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 || fs.Arg(0) != "gmail" {
		return fmt.Errorf("usage: bank auth gmail [--port n]")
	}
	return gmail.Authorize(ctx, dataDir(), *port)
}

func cmdSync(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	full := fs.Bool("full", false, "")
	if err := fs.Parse(args); err != nil {
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
	res, err := gmail.Sync(ctx, st, blobs, dataDir(), filepath.Join(dataDir(), "archive"), *full)
	if err != nil {
		return err
	}
	fmt.Printf("gmail (%s): %d new, %d already known, %d attachments", res.Mode, res.Inserted, res.Duplicates, res.Attachments)
	if res.Failed > 0 {
		fmt.Printf(", %d failed", res.Failed)
	}
	fmt.Println()
	return nil
}

func cmdImport(ctx context.Context, args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: bank import <whatsapp|eml|mbox|discord|linkedin|chatgpt|claude|claude-code|json> <path>...")
	}
	kind := args[0]
	fs := flag.NewFlagSet("import "+kind, flag.ExitOnError)
	defaultSource := map[string]string{"eml": "proton", "mbox": "gmail"}[kind]
	source := fs.String("source", defaultSource, "")
	if err := parseFlagsAnywhere(fs, args[1:]); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("usage: bank import %s <path>...", kind)
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
	archiveDir := filepath.Join(dataDir(), "archive")

	for _, path := range fs.Args() {
		switch kind {
		case "whatsapp":
			res, err := whatsapp.Import(ctx, st, blobs, archiveDir, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			fmt.Printf("%s: %d new, %d already known, %d attachments", res.Thread, res.Inserted, res.Duplicates, res.Attachments)
			if res.MissingMedia > 0 {
				fmt.Printf(", %d media files referenced but not in export", res.MissingMedia)
			}
			fmt.Println()
		case "eml":
			res, err := eml.ImportEmlPath(ctx, st, blobs, archiveDir, *source, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			printEmlResult(*source, path, res)
		case "mbox":
			res, err := eml.ImportMbox(ctx, st, blobs, archiveDir, *source, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			printEmlResult(*source, path, res)
		case "discord":
			res, err := discord.Import(ctx, st, archiveDir, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			fmt.Printf("discord: %d channels, %d new, %d already known, %d empty rows skipped\n",
				res.Channels, res.Inserted, res.Duplicates, res.Skipped)
		case "linkedin":
			res, err := linkedin.Import(ctx, st, archiveDir, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			fmt.Printf("linkedin: %d new, %d already known, %d empty rows skipped\n",
				res.Inserted, res.Duplicates, res.Skipped)
		case "chatgpt", "claude", "claude-code":
			var res aichat.Result
			switch kind {
			case "chatgpt":
				res, err = aichat.ImportChatGPT(ctx, st, archiveDir, path)
			case "claude":
				res, err = aichat.ImportClaude(ctx, st, archiveDir, path)
			case "claude-code":
				res, err = aichat.ImportClaudeCode(ctx, st, archiveDir, path)
			}
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			fmt.Printf("%s: %d conversations, %d new, %d already known, %d empty skipped\n",
				kind, res.Conversations, res.Inserted, res.Duplicates, res.Skipped)
		case "json":
			var input []byte
			var rawRef string
			if path == "-" {
				if input, err = io.ReadAll(os.Stdin); err != nil {
					return err
				}
				sum := sha256.Sum256(input)
				name := fmt.Sprintf("stdin-%x.json", sum[:6])
				if rawRef, err = archive.Write(archiveDir, "json", name, input); err != nil {
					return err
				}
			} else {
				if input, err = os.ReadFile(path); err != nil {
					return err
				}
				if rawRef, err = archive.Copy(archiveDir, "json", path); err != nil {
					return err
				}
			}
			res, err := generic.Import(ctx, st, blobs, *source, rawRef, input, time.Now())
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			fmt.Printf("json: %d new, %d already known, %d attachments", res.Inserted, res.Duplicates, res.Attachments)
			if res.Failed > 0 {
				fmt.Printf(", %d entries rejected", res.Failed)
			}
			fmt.Println()
		default:
			return fmt.Errorf("unknown import source %q (whatsapp, eml, mbox, discord, linkedin, chatgpt, claude, claude-code, json)", kind)
		}
	}
	return nil
}

func printEmlResult(source, path string, res eml.Result) {
	fmt.Printf("%s (%s): %d new, %d already known, %d attachments", source, filepath.Base(path), res.Inserted, res.Duplicates, res.Attachments)
	if res.Failed > 0 {
		fmt.Printf(", %d failed to parse", res.Failed)
	}
	fmt.Println()
}

func cmdSearch(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("search", flag.ExitOnError)
	var o store.SearchOpts
	var since, until string
	var asJSON bool
	fs.StringVar(&o.Source, "source", "", "")
	fs.StringVar(&o.From, "from", "", "")
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

	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	msgs, err := st.Search(ctx, query, o)
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

	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	m, atts, err := st.GetMessage(ctx, id)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(struct {
			store.Message
			Attachments []store.Attachment `json:"attachments,omitempty"`
		}{m, atts})
	}

	fmt.Printf("id:      %d\nsource:  %s\nthread:  %s\nfrom:    %s\ndate:    %s\n",
		m.ID, m.Source, m.ThreadID, m.Sender, m.SentAt.Format(time.RFC1123))
	if m.Subject != "" {
		fmt.Printf("subject: %s\n", m.Subject)
	}
	fmt.Printf("\n%s\n", m.Body)
	if len(atts) > 0 {
		blobs, _ := blob.New(filepath.Join(dataDir(), "blobs"))
		fmt.Println()
		for _, a := range atts {
			fmt.Printf("attachment: %s (%d bytes)  %s\n", a.Filename, a.SizeBytes, blobs.Path(a.SHA256))
		}
	}
	return nil
}

func cmdStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := openStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	stats, err := st.Stats(ctx)
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
		fmt.Printf("%-12s %8d messages  %s — %s\n",
			s.Source, s.Messages, s.Earliest.Format("2006-01-02"), s.Latest.Format("2006-01-02"))
		total += s.Messages
	}
	fmt.Printf("%-12s %8d messages\n", "total", total)
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

func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
