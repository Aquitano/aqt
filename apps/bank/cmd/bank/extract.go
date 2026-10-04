package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/extract"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

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
		return fmt.Errorf("usage: bank attachment <find|messages|list|stats|text> ...")
	}
	switch args[0] {
	case "find":
		return cmdAttachmentFind(ctx, args[1:])
	case "messages":
		return cmdAttachmentMessages(ctx, args[1:])
	case "list":
		return cmdAttachmentList(ctx, args[1:])
	case "stats":
		return cmdAttachmentStats(ctx, args[1:])
	case "text":
		return cmdAttachmentText(ctx, args[1:])
	}
	return fmt.Errorf("unknown attachment command %q (want find, messages, list, stats or text)", args[0])
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

func (l *stringList) String() string { return strings.Join(*l, ",") }

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
