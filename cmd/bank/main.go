// bank is the CLI for the aqt-bank personal message archive.
// Every read command supports --json so agents can consume the output.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
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
	"github.com/aquitano/aqt-bank/internal/extract"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/generic"
	"github.com/aquitano/aqt-bank/internal/gmail"
	"github.com/aquitano/aqt-bank/internal/inbox"
	"github.com/aquitano/aqt-bank/internal/linkedin"
	"github.com/aquitano/aqt-bank/internal/server"
	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/verify"
	"github.com/aquitano/aqt-bank/internal/webui"
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
  bank import codex <file.jsonl|dir>          Codex CLI session rollouts
  bank import opencode <opencode.db|dir>      OpenCode session database
  bank import antigravity <transcript|dir>    Antigravity conversation transcripts
  bank import ai                              all of the above from their default
                                              locations (~/.claude, ~/.codex, ...)
  bank import json [--source s] <file|->      arbitrary JSON/NDJSON messages
                                              (the escape hatch for agents; - reads stdin)
  bank import inbox [--json]                  sweep $BANK_DATA_DIR/inbox/<kind>/
  bank import ... [--no-extract]              skip reading text out of attachments
  bank reimport <source>                      replay archived inputs through the current importer
  bank reimport mbox --heal-bodies [--apply]  re-read archived mail and replace stub bodies
                                              today's parser reads better (dry run by default)
  bank extract [--ocr] [--status s]           read text out of attachments
  bank attachment list [--status s]           attachment content and its text status
  bank attachment stats [--json]              how much of the archive is searchable inside
  bank attachment text <sha256> [--set f]     read, replace or clear that text
  bank search <query> [flags]                 full-text search (BM25, fuzzy)
  bank thread <id> [--source s] [--limit n]   one whole conversation, oldest first
  bank contact <add|list|show|alias|...>      one person across their many identities
  bank show <id|ref> [--json]                 print one message + attachments
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
  --from name    filter by sender (substring, case-insensitive)
  --to name      filter by recipient (substring, case-insensitive)
  --person name  filter by contact, across all their aliases (bank contact)
  --since date   YYYY-MM-DD
  --until date   YYYY-MM-DD (exclusive)
  --fuzzy n      typo tolerance 0-2 (default 1)
  --limit n      max results, 1-500 (default 20)
  --offset n     skip this many ranked results, for the next page (max 10000)
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
		return fmt.Errorf("usage: bank import <inbox|ai|whatsapp|eml|mbox|discord|linkedin|chatgpt|claude|claude-code|codex|opencode|antigravity|json> <path>...")
	}
	kind := args[0]
	if kind == "inbox" {
		return cmdImportInbox(ctx, args[1:])
	}
	if kind == "ai" {
		return cmdImportAI(ctx, args[1:])
	}
	fs := flag.NewFlagSet("import "+kind, flag.ExitOnError)
	source := fs.String("source", defaultSource(kind), "")
	noExtract := fs.Bool("no-extract", false, "")
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
	return extractAfterImport(ctx, extract.Local{Store: d.st, Blobs: d.blobs}, *noExtract)
}

// cmdImportAI sweeps every known AI coding harness's default session
// locations — the registry in internal/aichat — so a cron line needs no
// per-tool paths. Missing roots are reported rather than skipped silently:
// "0 sessions" and "looked in the wrong place" must stay distinguishable.
func cmdImportAI(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("import ai", flag.ExitOnError)
	noExtract := fs.Bool("no-extract", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("usage: bank import ai  (one path imports via bank import <codex|claude-code|opencode|antigravity>)")
	}
	if c := client.FromEnv(); c != nil {
		return importAIRemote(ctx, c)
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()
	runs, err := aichat.ImportAll(ctx, d.st, d.archiveDir)
	for _, r := range runs {
		printHarnessRun(r)
	}
	if err != nil {
		return err
	}
	return extractAfterImport(ctx, extract.Local{Store: d.st, Blobs: d.blobs}, *noExtract)
}

func printHarnessRun(r aichat.HarnessRun) {
	switch {
	case r.Missing:
		fmt.Printf("%s: nothing at %s\n", r.Kind, r.Root)
	case r.Error != "":
		fmt.Printf("%s (%s): %s\n", r.Kind, r.Root, r.Error)
	default:
		printAIChatResult(r.Kind, r.Root, *r.Result)
	}
}

// importAIRemote is the same sweep against a `bank serve`: sessions are
// discovered locally and uploaded one file at a time. One broken harness or
// one refused file must not cost the harnesses after it — failures are
// reported, the sweep continues, and a nonzero count fails the run at the
// end, mirroring how the local ImportAll treats per-root errors.
func importAIRemote(ctx context.Context, c *client.Client) error {
	staging, err := os.MkdirTemp(stagingDir(), "ai-import-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	var failed int
	for _, h := range aichat.Harnesses() {
		for _, root := range h.Roots() {
			if _, err := os.Stat(root); err != nil {
				fmt.Printf("%s: nothing at %s\n", h.Kind, root)
				continue
			}
			files, err := h.Files(root, staging)
			if err != nil {
				failed++
				fmt.Fprintf(os.Stderr, "bank: %s: %v\n", root, err)
				continue
			}
			for _, f := range files {
				if err := importRemoteFile(ctx, c, h.Kind, "", f); err != nil {
					failed++
					fmt.Fprintf(os.Stderr, "bank: %s: %v\n", f, err)
				}
			}
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d upload(s) failed", failed)
	}
	return nil
}

// extractAfterImport reads text out of whatever the import just stored, so a
// PDF is searchable the moment it lands rather than after a command nobody
// remembers to run. Newest content first: the batch is bounded, and a backlog
// of large pending blobs would otherwise consume all of it before reaching the
// file that just arrived.
//
// Only the cheap extractors run: OCR is minutes per document and needs tools
// that are deliberately absent from the deployed image, so it stays an
// explicit `bank extract --ocr`. Failures here are reported and not fatal —
// the messages are already archived, and text is rebuildable.
//
// What it did goes to stderr, not stdout: this runs inside `bank import inbox
// --json`, whose stdout is a JSON document an agent parses.
func extractAfterImport(ctx context.Context, a extract.Archive, skip bool) error {
	if skip || os.Getenv("BANK_EXTRACT") == "off" {
		return nil
	}
	o := extract.DefaultOptions()
	o.TempDir = stagingDir()
	sel := extract.Selection{Limit: extract.PostImportLimit, NewestFirst: true}
	sum, err := extract.Run(ctx, a, sel, o, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bank: reading attachment text: %v\n", err)
		return nil
	}
	if sum.Considered > 0 {
		fmt.Fprintf(os.Stderr, "attachment text: %d read, %d need OCR, %d messages reindexed\n",
			sum.ByStatus[string(extract.StatusOK)], sum.ByStatus[string(extract.StatusNeedsOCR)], sum.Reindexed)
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
		return aichat.ImportChatGPT(ctx, d.st, d.blobs, d.archiveDir, path)
	case "claude":
		return aichat.ImportClaude(ctx, d.st, d.archiveDir, path)
	case "claude-code":
		return aichat.ImportClaudeCode(ctx, d.st, d.archiveDir, path)
	case "codex":
		return aichat.ImportCodex(ctx, d.st, d.archiveDir, path)
	case "opencode":
		return aichat.ImportOpenCode(ctx, d.st, d.archiveDir, path)
	case "antigravity":
		return aichat.ImportAntigravity(ctx, d.st, d.archiveDir, path)
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
	noExtract := fs.Bool("no-extract", false, "")
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
	if err := extractAfterImport(ctx, extract.Local{Store: d.st, Blobs: d.blobs}, *noExtract); err != nil {
		return err
	}
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
	if res.Settling > 0 {
		fmt.Printf("%d entr(ies) modified moments ago were left for the next sweep\n", res.Settling)
	}
	return sweepErr
}

// reimportKinds are the sources bank reimport can replay: their kind and
// source coincide, their importer reads back the same file shape it archived,
// and the original filename is recoverable from the archived name. Mail is
// absent deliberately — gmail archives one .eml per synced message, and
// eml/mbox archives live under a --source (proton, gmail, ...) that does not
// determine the kind. `reimport mbox --heal-bodies` is the one pass that does
// re-read mail, and it repairs one column instead of replaying an import.
var reimportKinds = []string{"chatgpt", "claude", "claude-code", "codex", "opencode", "antigravity", "discord", "whatsapp", "linkedin"}

// healBodiesKind is the pseudo-kind that reaches the mail healer. It is a kind
// rather than a command of its own because it is the same operation from the
// operator's side: read what was archived, apply what the code learned since.
const healBodiesKind = "mbox"

// cmdReimport replays every archived raw input of one source through the
// current importer. Imports are idempotent, so the only visible effect is
// whatever today's importer does better than the one that first read the file
// — messages it used to drop, threads it used to key wrong.
func cmdReimport(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("reimport", flag.ExitOnError)
	noExtract := fs.Bool("no-extract", false, "")
	asJSON := fs.Bool("json", false, "")
	healBodies := fs.Bool("heal-bodies", false, "")
	apply := fs.Bool("apply", false, "")
	source := fs.String("source", "", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank reimport <%s> [--no-extract] [--json]", strings.Join(reimportKinds, "|"))
	}
	kind := fs.Arg(0)
	if client.FromEnv() != nil {
		return fmt.Errorf("reimport replays the server's own archive; run it there, not through BANK_URL")
	}
	if kind == healBodiesKind {
		if !*healBodies {
			return fmt.Errorf("mail is not replayed wholesale; `bank reimport mbox --heal-bodies` re-reads it to replace stub bodies today's parser reads better")
		}
		return healMailBodies(ctx, *source, *apply, *asJSON)
	}
	if *healBodies || *apply || *source != "" {
		return fmt.Errorf("--heal-bodies, --apply and --source belong to `bank reimport %s`", healBodiesKind)
	}
	if !slices.Contains(reimportKinds, kind) {
		return fmt.Errorf("cannot replay %q; reimport covers %s", kind, strings.Join(reimportKinds, ", "))
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	entries, err := archive.List(d.archiveDir, kind)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Printf("nothing archived under %s\n", filepath.Join(d.archiveDir, kind))
		return nil
	}
	staging, err := os.MkdirTemp(stagingDir(), "reimport-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)

	type replayed struct {
		Ref    string `json:"ref"`
		Result any    `json:"result,omitempty"`
		Error  string `json:"error,omitempty"`
	}
	var out []replayed
	var failed int
	for i, e := range entries {
		// One directory per input: original names repeat across exports
		// (every merged ChatGPT export stages as conversations.json).
		sub := filepath.Join(staging, strconv.Itoa(i))
		if err := os.Mkdir(sub, 0o700); err != nil {
			return err
		}
		p, err := archive.Stage(d.archiveDir, e, sub)
		if err != nil {
			return fmt.Errorf("stage %s: %w", e.Ref, err)
		}
		res, err := importLocal(ctx, d, kind, "", p)
		if err != nil {
			// A file today's importer cannot parse must not cost the rest of
			// the replay; anything operational (database, archive) still
			// aborts, as one failure would just repeat for every input.
			if fail.IsOp(err) {
				return fmt.Errorf("%s: %w", e.Ref, err)
			}
			failed++
			out = append(out, replayed{Ref: e.Ref, Error: err.Error()})
			fmt.Fprintf(os.Stderr, "bank: skipping %s: %v\n", e.Ref, err)
			continue
		}
		out = append(out, replayed{Ref: e.Ref, Result: res})
		if !*asJSON {
			printImportResult(kind, "", e.Ref, res)
		}
	}
	if *asJSON {
		if err := printJSON(out); err != nil {
			return err
		}
	}
	if err := extractAfterImport(ctx, extract.Local{Store: d.st, Blobs: d.blobs}, *noExtract); err != nil {
		return err
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d archived inputs failed to replay", failed, len(entries))
	}
	return nil
}

// healMailBodies re-reads one mail source's archived raws and replaces bodies
// the current parser reads better than the one that first imported them. It
// reports without writing unless apply is set: the write is the one exception
// to "a re-import never overwrites a body", so it should be read before it is
// taken.
func healMailBodies(ctx context.Context, source string, apply, asJSON bool) error {
	if source == "" {
		source = defaultSource(healBodiesKind)
	}
	if err := archive.ValidSource(source); err != nil {
		return err
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return err
	}
	defer closeStore()

	verb := "would heal"
	if apply {
		verb = "healed"
	}
	heals := []eml.BodyHeal{}
	res, err := eml.HealBodies(ctx, d.st, d.archiveDir, source, apply, func(h eml.BodyHeal) {
		if asJSON {
			heals = append(heals, h)
			return
		}
		fmt.Printf("%s: id=%d ref=%s subject=%q stored=%d reparsed=%d\n",
			verb, h.ID, h.Ref, h.Subject, h.Stored, h.Reparsed)
	})
	if err != nil {
		return err
	}
	if asJSON {
		return printJSON(struct {
			eml.HealResult
			Heals []eml.BodyHeal `json:"heals"`
		}{res, heals})
	}
	printHealResult(source, res)
	return nil
}

func printHealResult(source string, res eml.HealResult) {
	outcome := "to heal"
	if res.Applied {
		outcome = "healed"
	}
	fmt.Printf("%s: %s, %s read, %d still archived, %d %s",
		source, plural(res.Files, "raw file"), plural(res.Messages, "message"), res.Matched, res.Healed, outcome)
	if res.Rejected > 0 {
		fmt.Printf(", %d unreadable", res.Rejected)
	}
	fmt.Println()
	if !res.Applied && res.Healed > 0 {
		fmt.Println("dry run — pass --apply to write these bodies")
	}
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
		printAIChatResult(kind, path, r)
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

// printAIChatResult names the file it is reporting on, so a sharded export does
// not print a wall of indistinguishable lines, and reconciles the conversations
// found in the input against the ones that made it in — a gap between the two
// is the only visible sign of silently dropped conversations.
func printAIChatResult(kind, path string, res aichat.Result) {
	found := res.Conversations + res.EmptyConversations
	fmt.Printf("%s (%s): %d conversations found, %d imported, %d new, %d already known, %d skipped",
		kind, filepath.Base(path), found, res.Conversations, res.Inserted, res.Duplicates, res.Skipped)
	if res.EmptyConversations > 0 {
		fmt.Printf(", %d conversations without importable messages", res.EmptyConversations)
	}
	if res.SubagentSessions > 0 {
		fmt.Printf(", %d subagent sessions skipped", res.SubagentSessions)
	}
	if res.UnchangedSessions > 0 {
		fmt.Printf(", %d unchanged since last sync", res.UnchangedSessions)
	}
	if res.Attachments > 0 || res.MissingMedia > 0 {
		fmt.Printf(", %d attachments (%d missing from export)", res.Attachments, res.MissingMedia)
	}
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
// files, so directory inputs are expanded here, and harness inputs that
// cannot ship as-is (a live SQLite database, a transcript named only by its
// path) are staged into shippable files first.
func importRemote(ctx context.Context, c *client.Client, kind, source string, paths []string) error {
	staging, err := os.MkdirTemp(stagingDir(), "remote-import-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
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
		files, err := remoteImportFiles(kind, path, staging)
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

func remoteImportFiles(kind, path, staging string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if h, ok := aichat.HarnessByKind(kind); ok {
		return h.Files(path, staging)
	}
	if !info.IsDir() {
		return []string{path}, nil
	}
	if kind != "eml" {
		return nil, fmt.Errorf("%s: remote import of %s takes a file, not a directory", path, kind)
	}
	var out []string
	err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".eml") {
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
	case "chatgpt", "claude", "claude-code", "codex", "opencode", "antigravity":
		res, err := client.ImportFile[aichat.Result](ctx, c, kind, source, path)
		if err != nil {
			return err
		}
		printAIChatResult(kind, path, res)
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
	fs.IntVar(&o.Offset, "offset", 0, "")
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

	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
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
	limit := fs.Int("limit", 0, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("usage: bank thread <id> [--source s] [--limit n] [--json]")
	}
	threadID := strings.Join(fs.Args(), " ")

	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	thread, err := b.GetThread(ctx, *source, threadID, *limit)
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
		if m.Subject != "" && m.Subject != title {
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
		return fmt.Errorf("usage: bank show <id|ref> [--json]")
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
	fmt.Printf("id:      %d\nref:     %s\nsource:  %s\nthread:  %s\nfrom:    %s\ndate:    %s\n",
		m.ID, m.Ref, m.Source, m.ThreadID, m.Sender, m.SentAt.Format(time.RFC1123))
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

// backend is the archive as the read commands use it. The local store and a
// remote `bank serve` answer to the same method names, so no command below
// has to know which it is talking to.
type backend interface {
	Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error)
	GetMessageDetail(ctx context.Context, id int64) (store.MessageDetail, error)
	GetMessageDetailByRef(ctx context.Context, ref string) (store.MessageDetail, error)
	GetThread(ctx context.Context, source, threadID string, limit int) (store.Thread, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
	SetCoverage(ctx context.Context, source, text string) error
	CreateContact(ctx context.Context, name, note string) (store.Contact, error)
	ImportContacts(ctx context.Context, in []store.ContactImport) ([]store.ContactImportResult, error)
	DeleteContact(ctx context.Context, name string) error
	ListContacts(ctx context.Context) ([]store.Contact, error)
	GetContactDetail(ctx context.Context, name string) (store.ContactDetail, error)
	AddAlias(ctx context.Context, name, source, value string) (store.ContactAlias, error)
	RemoveAlias(ctx context.Context, name, source, value string) error
	ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.Message, error)
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
	w.Flush()
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
		return fmt.Errorf("invalid BANK_URL: %v", err)
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
	"codex", "opencode", "antigravity",
}

const contactUsage = `usage: bank contact <add|rm|list|show|alias|messages|suggest|import> ...

  bank contact add <name> [--note text]
  bank contact rm <name>
  bank contact list [--json]
  bank contact show <name> [--json]
  bank contact alias add <name> <alias>...
  bank contact alias rm <name> <alias>...
  bank contact messages <name> [--source s] [--since d] [--until d] [--limit n] [--json]
  bank contact suggest [--limit n] [--json]
  bank contact import <file|-> [--json]

An alias is an identity that means this person: an email address, a WhatsApp
display name, a Discord handle. It matches everywhere by default; write it as
"<source>:<value>" to bind it to one source.

import takes a JSON array or NDJSON of
{"name": "...", "note": "...", "aliases": ["whatsapp:...", "a@example.com"]}.`

func cmdContact(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New(contactUsage)
	}
	b, closeBackend, err := openBackend(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()

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
	case "import":
		return contactImport(ctx, b, args[1:])
	}
	return fmt.Errorf("unknown contact command %q\n\n%s", args[0], contactUsage)
}

func contactAdd(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact add", flag.ExitOnError)
	note := fs.String("note", "", "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact add <name> [--note text]")
	}
	c, err := b.CreateContact(ctx, fs.Arg(0), *note)
	if err != nil {
		return err
	}
	fmt.Printf("contact %s\nattach identities with: bank contact alias add %s <email|handle>\n", c.Name, c.Name)
	return nil
}

func contactRemove(ctx context.Context, b backend, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: bank contact rm <name>")
	}
	if err := b.DeleteContact(ctx, args[0]); err != nil {
		return contactErr(args[0], err)
	}
	// Worth saying plainly: this is a lens, not the data.
	fmt.Printf("contact %s removed; its messages are untouched\n", args[0])
	return nil
}

func contactList(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact list", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	contacts, err := b.ListContacts(ctx)
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

func contactShow(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact show", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact show <name> [--json]")
	}
	d, err := b.GetContactDetail(ctx, fs.Arg(0))
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

func contactAlias(ctx context.Context, b backend, args []string) error {
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
			a, err := b.AddAlias(ctx, name, source, value)
			if err != nil {
				return contactErr(name, err)
			}
			fmt.Printf("%s: %s %s\n", name, a.Normalized, scopeLabel(a.Source))
		case "rm", "remove":
			if err := b.RemoveAlias(ctx, name, source, value); err != nil {
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
func knownSources(ctx context.Context, b backend) (map[string]bool, error) {
	out := map[string]bool{}
	for _, s := range builtinSources {
		out[s] = true
	}
	stats, err := b.Stats(ctx)
	if err != nil {
		return nil, err
	}
	for _, s := range stats {
		out[s.Source] = true
	}
	return out, nil
}

func contactMessages(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact messages", flag.ExitOnError)
	var o store.ContactMessagesOpts
	var since, until string
	var asJSON bool
	fs.StringVar(&o.Source, "source", "", "")
	fs.StringVar(&since, "since", "", "")
	fs.StringVar(&until, "until", "", "")
	fs.IntVar(&o.Limit, "limit", 50, "")
	fs.IntVar(&o.Offset, "offset", 0, "")
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
	msgs, err := b.ContactMessages(ctx, fs.Arg(0), o)
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
	printMorePages(len(msgs), o.Limit, o.Offset)
	return nil
}

func contactSuggest(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact suggest", flag.ExitOnError)
	limit := fs.Int("limit", 20, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	out, err := b.SuggestIdentities(ctx, *limit)
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

// contactEntry is the import file's shape. Aliases are written the way the
// alias command takes them ("whatsapp:Alice", "alice@example.com") and are
// resolved against the known sources here, so the file needs no scope field.
type contactEntry struct {
	Name    string   `json:"name"`
	Note    string   `json:"note"`
	Aliases []string `json:"aliases"`
}

// contactImport applies a whole contact book at once — the practical way to
// turn an address-book export into contacts, one identity per line, instead of
// a shell loop over `contact add` and `contact alias add`. Conflicts are
// reported and skipped: the file is the owner's, and one alias another contact
// already claims must not cost the rest of it.
func contactImport(ctx context.Context, b backend, args []string) error {
	fs := flag.NewFlagSet("contact import", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: bank contact import <file|-> [--json]")
	}
	input, err := readInput(fs.Arg(0))
	if err != nil {
		return err
	}
	entries, err := decodeJSONEntries[contactEntry](input)
	if err != nil {
		return fmt.Errorf("%s: %w", fs.Arg(0), err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("%s holds no contacts", fs.Arg(0))
	}
	known, err := knownSources(ctx, b)
	if err != nil {
		return err
	}
	in := make([]store.ContactImport, 0, len(entries))
	for _, e := range entries {
		c := store.ContactImport{Name: e.Name, Note: e.Note}
		for _, raw := range e.Aliases {
			source, value := store.ContactAliasScope(raw, func(s string) bool { return known[s] })
			c.Aliases = append(c.Aliases, store.ImportedAlias{Source: source, Value: value})
		}
		in = append(in, c)
	}

	res, err := b.ImportContacts(ctx, in)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(res)
	}
	var created, aliases, failed int
	for _, r := range res {
		state := "existing"
		if r.Created {
			state = "created"
			created++
		}
		aliases += r.Aliases
		fmt.Printf("%-20s %-8s %d aliases\n", r.Name, state, r.Aliases)
		for _, e := range r.Errors {
			failed++
			fmt.Fprintf(os.Stderr, "bank: %s: %s\n", r.Name, e)
		}
	}
	fmt.Printf("%d contacts (%d created), %d aliases attached", len(res), created, aliases)
	if failed > 0 {
		fmt.Printf(", %d skipped", failed)
	}
	fmt.Println()
	return nil
}

// decodeJSONEntries reads a JSON array or a stream of newline-delimited
// objects, the same two shapes `bank import json` accepts.
func decodeJSONEntries[T any](input []byte) ([]T, error) {
	dec := json.NewDecoder(bytes.NewReader(input))
	tok, err := dec.Token()
	if err == io.EOF {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '[' {
		dec = json.NewDecoder(bytes.NewReader(input)) // not an array: a stream of objects
	}
	var out []T
	for dec.More() {
		var v T
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// contactErr turns the store's not-found sentinel into a message that names
// what was actually missing.
func contactErr(name string, err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no contact %q — see 'bank contact list'", name)
	}
	return err
}

// Extraction is a pass of its own, not a step inside importing. The text is
// derived data keyed on the blob digest, so it is rebuildable at any time, and
// keeping it separate is what lets the expensive half run somewhere other than
// the box serving the archive: `bank extract --ocr` against a remote BANK_URL
// runs the tools on this machine and stores only the text.
func cmdExtract(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("extract", flag.ExitOnError)
	var statuses stringList
	fs.Var(&statuses, "status", "")
	ocr := fs.Bool("ocr", false, "")
	lang := fs.String("lang", "eng", "")
	source := fs.String("source", "", "")
	limit := fs.Int("limit", 0, "")
	watch := fs.Bool("watch", false, "")
	interval := fs.Duration("interval", defaultWatchInterval, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	for _, s := range statuses {
		if err := extract.ValidRunStatus(s); err != nil {
			return err
		}
	}
	if *source != "" {
		if err := archive.ValidSource(*source); err != nil {
			return err
		}
	}

	o := extract.DefaultOptions()
	o.OCR = *ocr
	o.OCRLang = *lang
	o.TempDir = stagingDir()

	sel := extract.Selection{Statuses: statuses, Source: *source, Limit: *limit}

	var progress func(store.BlobRef, extract.Result)
	if !*asJSON {
		progress = func(b store.BlobRef, r extract.Result) {
			fmt.Fprintf(os.Stderr, "%-12s %8s  %s\n", r.Status, humanBytes(b.SizeBytes), excerpt(b.Filename, 60))
		}
	}

	backend, closeBackend, err := openAttachments(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()

	if *watch {
		if *asJSON {
			return fmt.Errorf("--json has no meaning with --watch, which runs until stopped")
		}
		return watchExtract(ctx, backend, sel, o, *interval)
	}

	sum, err := extract.Run(ctx, backend, sel, o, progress)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(sum)
	}
	printExtractSummary(sum)
	return nil
}

// defaultWatchInterval is how often --watch drains the queue. Nothing here is
// urgent: a scan dropped in the inbox becoming searchable within the half hour
// is the whole requirement.
const defaultWatchInterval = 30 * time.Minute

// minWatchInterval keeps a typo from turning the worker into a hot loop
// against Postgres.
const minWatchInterval = time.Minute

// watchExtract drains the queue on a timer until it is told to stop. It reads
// its work from the database rather than being handed it, which is what lets
// OCR be automatic without the server knowing a worker exists; DESIGN.md has
// the reasoning.
func watchExtract(ctx context.Context, a extract.Archive, sel extract.Selection, o extract.Options, interval time.Duration) error {
	if interval < minWatchInterval {
		return fmt.Errorf("--interval must be at least %s", minWatchInterval)
	}
	// Checked once here rather than per pass: missing tools are a
	// configuration mistake, and a worker that restarts forever while logging
	// the same line is worse than one that exits saying why.
	if o.OCR {
		if err := extract.OCRAvailable(o); err != nil {
			return err
		}
	}

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Fprintf(os.Stderr, "bank extract: watching, every %s\n", interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		sum, err := extract.Run(ctx, a, sel, o, nil)
		switch {
		case errors.Is(err, context.Canceled):
			return nil
		case err != nil:
			// A pass that failed is not a worker that should die: Postgres
			// restarting, or the disk filling and being cleared, must not need
			// a human to start this again.
			fmt.Fprintf(os.Stderr, "bank extract: %v\n", err)
		case sum.Considered > 0:
			fmt.Fprintf(os.Stderr, "bank extract: %d files, %d messages reindexed\n", sum.Considered, sum.Reindexed)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// attachmentBackend is the archive as the attachment commands use it: the
// extraction pass's own interface, plus the reads and writes only the CLI
// needs. Both the local store and a remote `bank serve` satisfy it, so no
// command below has to know which it is talking to.
type attachmentBackend interface {
	extract.Archive
	BlobText(ctx context.Context, sha256 string) (store.BlobText, error)
	SetText(ctx context.Context, bt store.BlobText) error
	DeleteBlobText(ctx context.Context, sha256 string) error
	ExtractionStats(ctx context.Context) ([]store.ExtractionStat, error)
}

func openAttachments(ctx context.Context) (attachmentBackend, func(), error) {
	if c := client.FromEnv(); c != nil {
		c.SetTempDir(stagingDir())
		return c, func() {}, nil
	}
	d, closeStore, err := openLocal(ctx)
	if err != nil {
		return nil, nil, err
	}
	return extract.Local{Store: d.st, Blobs: d.blobs}, closeStore, nil
}

// stagingDir is where downloads and rasterized pages go: the data directory,
// which is the one writable mount in the deployed container and is sized for
// archive-scale files, unlike a small /tmp tmpfs.
var pruneStagingOnce sync.Once

func stagingDir() string {
	dir := filepath.Join(dataDir(), "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	// Every command that stages here also sweeps the debris of commands that
	// were killed before their own cleanup — an interrupted reimport leaves a
	// full copy of a source's archive behind.
	pruneStagingOnce.Do(func() { pruneStaging(dir, stagingMaxAge) })
	return dir
}

// stagingMaxAge is how long staging debris may sit before it is treated as
// abandoned. Long enough that nothing in flight is ever swept: an OCR pass
// bounded at five minutes per document, or an import running beside the
// worker, is using entries far younger than this.
const stagingMaxAge = 24 * time.Hour

// pruneStaging removes rasterized pages, downloaded blobs and reimport
// staging left behind when a run was killed before its own cleanup could run.
// Best effort: a failure here is not worth a command that refuses to start.
func pruneStaging(dir string, maxAge time.Duration) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, e := range entries {
		known := false
		for _, prefix := range []string{"ocr-", "blob-", "reimport-", "ai-import-", "remote-import-"} {
			if strings.HasPrefix(e.Name(), prefix) {
				known = true
				break
			}
		}
		if !known {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		os.RemoveAll(filepath.Join(dir, e.Name()))
	}
}

func printExtractSummary(sum extract.Summary) {
	if sum.Considered == 0 && sum.Reindexed == 0 {
		fmt.Println("nothing to extract")
		return
	}
	for _, st := range extract.Statuses {
		if n := sum.ByStatus[string(st)]; n > 0 {
			fmt.Printf("%-12s %6d\n", st, n)
		}
	}
	if sum.Chars > 0 {
		fmt.Printf("%-12s %6s characters\n", "extracted", humanCount(sum.Chars))
	}
	fmt.Printf("%-12s %6d messages\n", "reindexed", sum.Reindexed)
	for _, e := range sum.Errors {
		fmt.Fprintf(os.Stderr, "bank: %s\n", e)
	}
	if n := sum.ByStatus[string(extract.StatusNeedsOCR)]; n > 0 {
		fmt.Fprintf(os.Stderr,
			"\n%d files hold text only as pixels. `bank extract --ocr` reads them, or fetch them\n"+
				"with `bank fetch` and post your own transcription with `bank attachment text --set`.\n", n)
	}
	// Failures are terminal unless someone asks for them again: no default
	// pass selects them, so a scan that merely ran out of time would sit there
	// unread and unmentioned.
	if n := sum.ByStatus[string(extract.StatusFailed)]; n > 0 {
		fmt.Fprintf(os.Stderr,
			"\n%d files could not be read and nothing retries them on its own.\n"+
				"`bank extract --status failed` (with --ocr if they need it) tries again;\n"+
				"a long scan that ran out of time often finishes on a second pass.\n", n)
	}
}

func cmdAttachment(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: bank attachment <list|stats|text> ...")
	}
	switch args[0] {
	case "list":
		return cmdAttachmentList(ctx, args[1:])
	case "stats":
		return cmdAttachmentStats(ctx, args[1:])
	case "text":
		return cmdAttachmentText(ctx, args[1:])
	}
	return fmt.Errorf("unknown attachment command %q (want list, stats or text)", args[0])
}

// cmdAttachmentStats answers how much of the archive is searchable inside its
// attachments — and, in the needs_ocr row, exactly how much OCR would add.
// That number is what should decide whether running OCR is worth it.
func cmdAttachmentStats(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("attachment stats", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	b, closeBackend, err := openAttachments(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	stats, err := b.ExtractionStats(ctx)
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(stats)
	}
	if len(stats) == 0 {
		fmt.Println("no attachments")
		return nil
	}
	printExtractionStats(stats)
	return nil
}

func printExtractionStats(stats []store.ExtractionStat) {
	var blobs, bytes, chars int64
	for _, s := range stats {
		fmt.Printf("%-12s %6d files  %8s  %8s searchable characters\n",
			s.Status, s.Blobs, humanBytes(s.Bytes), humanCount(s.Chars))
		blobs += s.Blobs
		bytes += s.Bytes
		chars += s.Chars
	}
	fmt.Printf("%-12s %6d files  %8s  %8s searchable characters\n",
		"total", blobs, humanBytes(bytes), humanCount(chars))
}

func cmdAttachmentList(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("attachment list", flag.ExitOnError)
	var statuses stringList
	fs.Var(&statuses, "status", "")
	source := fs.String("source", "", "")
	limit := fs.Int("limit", 50, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	// The same check `bank extract --source` makes: a malformed source names
	// nothing, and an empty listing reads as an archive with no attachments.
	if *source != "" {
		if err := archive.ValidSource(*source); err != nil {
			return err
		}
	}
	b, closeBackend, err := openAttachments(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()
	blobs, err := b.ListBlobs(ctx, store.ListBlobsOpts{Statuses: statuses, Source: *source, Limit: *limit})
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(blobs)
	}
	if len(blobs) == 0 {
		fmt.Println("no attachments")
		return nil
	}
	for _, b := range blobs {
		fmt.Printf("%s  %-12s %8s  %s\n", b.SHA256[:12], b.Status, humanBytes(b.SizeBytes), excerpt(b.Filename, 50))
	}
	return nil
}

// cmdAttachmentText reads, replaces or clears one blob's text. Replacing is
// how text from a model running here — better than tesseract, or reading a
// language it does not — gets into the archive; it lands as "manual", which
// no automatic pass overwrites.
func cmdAttachmentText(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("attachment text", flag.ExitOnError)
	set := fs.String("set", "", "")
	clear := fs.Bool("clear", false, "")
	asJSON := fs.Bool("json", false, "")
	if err := parseFlagsAnywhere(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: bank attachment text <sha256> [--set <file|-> | --clear] [--json]")
	}
	sum := strings.ToLower(fs.Arg(0))
	if err := store.ValidSHA256(sum); err != nil {
		return err
	}
	if *set != "" && *clear {
		return fmt.Errorf("--set and --clear do the opposite of each other")
	}

	b, closeBackend, err := openAttachments(ctx)
	if err != nil {
		return err
	}
	defer closeBackend()

	switch {
	case *clear:
		if err := b.DeleteBlobText(ctx, sum); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("no extracted text for %s", sum)
			}
			return err
		}
		return reindexAfterTextChange(ctx, b)

	case *set != "":
		text, err := readTextInput(*set)
		if err != nil {
			return err
		}
		// Refused rather than stored and silently cut in half: a transcription
		// is the one kind of text nothing here can produce again.
		if len(text) > store.MaxAttachmentTextChars {
			return fmt.Errorf("%s holds %d bytes of text, over the %d a row keeps",
				*set, len(text), store.MaxAttachmentTextChars)
		}
		if err := b.SetText(ctx, store.BlobText{
			SHA256: sum, Text: text, Extractor: "manual", Status: string(extract.StatusManual),
		}); err != nil {
			return err
		}
		return reindexAfterTextChange(ctx, b)
	}

	bt, err := b.BlobText(ctx, sum)
	if errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no extracted text for %s (run: bank extract)", sum)
	}
	if err != nil {
		return err
	}
	if *asJSON {
		return printJSON(bt)
	}
	fmt.Printf("sha256:    %s\nstatus:    %s\nextractor: %s\nchars:     %d\nextracted: %s\n\n",
		bt.SHA256, bt.Status, bt.Extractor, bt.Chars, bt.ExtractedAt.Format(time.RFC1123))
	fmt.Println(bt.Text)
	return nil
}

// reindexAfterTextChange copies the new text onto every message carrying that
// content. Editing text that never reaches the index would look like it
// worked and change nothing.
func reindexAfterTextChange(ctx context.Context, b attachmentBackend) error {
	n, err := b.RefreshAttachmentText(ctx)
	if err != nil {
		return err
	}
	fmt.Printf("reindexed %s\n", plural(int(n), "message"))
	return nil
}

func readTextInput(path string) (string, error) {
	if path == "-" {
		b, err := io.ReadAll(os.Stdin)
		return string(b), err
	}
	b, err := os.ReadFile(path)
	return string(b), err
}

// stringList collects a repeatable flag, so --status can be given more than once.
type stringList []string

func (l *stringList) String() string     { return strings.Join(*l, ",") }
func (l *stringList) Set(v string) error { *l = append(*l, v); return nil }

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%dB", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f%c", float64(n)/float64(div), "KMGT"[exp])
}

func humanCount(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	}
	return strconv.FormatInt(n, 10)
}
