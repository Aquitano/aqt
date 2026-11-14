package main

import (
	"cmp"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/extraction"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// The job queue reads every new content on its own. This is the manual pass:
// it re-reads a status after an extractor improved, or, against a remote
// BANK_URL, runs the tools on this machine and stores only the text.
type extractCmd struct {
	Status []string `sep:"none" help:"Work on this status (repeatable; default: content never tried): pending, ok, empty, needs_ocr, unsupported, too_big, failed. Not manual: transcriptions are only replaced by 'bank attachment text --set' or cleared with --clear."`
	OCR    bool     `name:"ocr" help:"Read images and text-layer-less PDFs (needs tesseract, poppler)."`
	Lang   string   `default:"eng" help:"OCR language, tesseract syntax (\"deu+eng\" for two)."`
	Source string   `help:"Only content carried by this source."`
	Limit  int      `help:"Stop after this many files, 1-${max_limit} (default ${max_limit}); run again for the rest."`
	JSON   bool     `help:"JSON output."`
}

func (c *extractCmd) Run(ctx context.Context) error {
	statuses := c.Status
	for _, s := range statuses {
		if err := extraction.ValidRunStatus(s); err != nil {
			return err
		}
	}

	o := extract.DefaultOptions()
	o.OCR = c.OCR
	o.OCRLang = c.Lang
	o.TempDir = stagingDir()

	sel := extraction.Selection{Statuses: statuses, Source: c.Source, Limit: c.Limit}

	var progress func(store.BlobRef, extract.Result)
	if !c.JSON {
		progress = func(b store.BlobRef, r extract.Result) {
			fmt.Fprintf(os.Stderr, "%-12s %8s  %s\n", r.Status, humanBytes(b.SizeBytes), excerpt(b.Filename, 60))
		}
	}

	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()

	sum, err := extraction.Run(ctx, apiArchive{api}, sel, o, progress)
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(sum)
	}
	printExtractSummary(sum)
	return nil
}

// apiArchive is what an extraction run reads and writes, through the API.
type apiArchive struct{ api *client.Client }

// ListBlobs takes the largest page when no limit is given; the next run takes
// the rest.
func (a apiArchive) ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error) {
	return client.Call(ctx, a.api, server.ListAttachments, server.AttachmentsInput{Status: o.Statuses, Source: o.Source,
		PageSize: httpapi.PageSize{Limit: cmp.Or(o.Limit, page.MaxLimit)}})
}

func (a apiArchive) PutBlobText(ctx context.Context, bt store.BlobText) error {
	_, err := client.Call(ctx, a.api, server.SetAttachmentText, server.SetAttachmentTextInput{BLAKE3: bt.BLAKE3,
		Status: bt.Status, Extractor: bt.Extractor, RawBody: []byte(bt.Text)})
	return err
}

// OpenBlob downloads the bytes to the staging directory, because the
// extractors seek and the OCR tools are subprocesses that take a path. The
// cleanup removes the copy.
func (a apiArchive) OpenBlob(ctx context.Context, d content.Digest) (string, func(), error) {
	body, err := client.Open(ctx, a.api, server.GetBlob, server.DigestInput{BLAKE3: d})
	if err != nil {
		return "", func() {}, err
	}
	defer body.Close()
	f, err := os.CreateTemp(stagingDir(), "blob-*")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { os.Remove(f.Name()) }
	_, err = io.Copy(f, body)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	return f.Name(), cleanup, nil
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

func printExtractSummary(sum extraction.Summary) {
	if sum.Considered == 0 {
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
	for _, e := range sum.Errors {
		fmt.Fprintf(os.Stderr, "bank: %s\n", e)
	}
	if n := sum.ByStatus[string(extract.StatusNeedsOCR)]; n > 0 {
		fmt.Fprintf(os.Stderr,
			"\n%d files hold text only as pixels and wait in the ocr queue for `bank worker --queue ocr`.\n"+
				"`bank extract --ocr` reads them here, or fetch them with `bank fetch` and post your own\n"+
				"transcription with `bank attachment text --set`.\n", n)
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

type attachmentCmd struct {
	Find     attachmentFindCmd     `cmd:"" help:"Search the attachment library."`
	Messages attachmentMessagesCmd `cmd:"" help:"Every message with this file, as JSON."`
	List     attachmentListCmd     `cmd:"" help:"Attachment content and its text status."`
	Stats    attachmentStatsCmd    `cmd:"" help:"How much of the archive is searchable inside."`
	Text     attachmentTextCmd     `cmd:"" help:"Read, replace or clear one file's text."`
}

// attachmentStatsCmd answers how much of the archive is searchable inside its
// attachments — and, in the needs_ocr row, exactly how much OCR would add.
// That number is what should decide whether running OCR is worth it.
type attachmentStatsCmd struct {
	JSON bool `help:"JSON output."`
}

func (c *attachmentStatsCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	stats, err := client.Call(ctx, api, server.GetAttachmentStats, struct{}{})
	if err != nil {
		return err
	}
	if c.JSON {
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

type attachmentListCmd struct {
	Status []string `sep:"none" help:"Only this text status (repeatable)."`
	Source string   `help:"Only content carried by this source."`
	Limit  int      `default:"${limit}" help:"How many files, 1-${max_limit}."`
	JSON   bool     `help:"JSON output."`
}

func (c *attachmentListCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	blobs, err := client.Call(ctx, api, server.ListAttachments, server.AttachmentsInput{Status: c.Status, Source: c.Source,
		PageSize: httpapi.PageSize{Limit: c.Limit}})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(blobs)
	}
	if len(blobs) == 0 {
		fmt.Println("no attachments")
		return nil
	}
	for _, b := range blobs {
		fmt.Printf("%s  %-12s %8s  %s\n", b.BLAKE3.String()[:12], b.Status, humanBytes(b.SizeBytes), excerpt(b.Filename, 50))
	}
	return nil
}

// attachmentTextCmd reads, replaces or clears one content's text. Replacing is
// how text from a model running here — better than tesseract, or reading a
// language it does not — gets into the archive; it lands as "manual", which
// no automatic pass overwrites.
type attachmentTextCmd struct {
	BLAKE3 content.Digest `arg:"" name:"blake3" help:"The content's BLAKE3 digest, 64 lowercase hex characters."`
	Set    string         `help:"Replace the text with this file's contents; - reads stdin."`
	Clear  bool           `help:"Drop the stored text."`
	JSON   bool           `help:"JSON output."`
}

func (c *attachmentTextCmd) Run(ctx context.Context) error {
	sum := c.BLAKE3
	if c.Set != "" && c.Clear {
		return fmt.Errorf("--set and --clear do the opposite of each other")
	}
	var text []byte
	if c.Set != "" {
		var err error
		if text, err = readInput(c.Set); err != nil {
			return err
		}
	}

	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()

	switch {
	case c.Clear:
		if _, err := client.Call(ctx, api, server.DeleteAttachmentText, server.DigestInput{BLAKE3: sum}); err != nil {
			return err
		}
		fmt.Printf("cleared the text of %s; it is queued to be read again\n", sum)
		return nil

	case c.Set != "":
		if _, err := client.Call(ctx, api, server.SetAttachmentText, server.SetAttachmentTextInput{BLAKE3: sum,
			Status: string(extract.StatusManual), Extractor: "manual", RawBody: text}); err != nil {
			return err
		}
		fmt.Printf("stored manual text for %s\n", sum)
		return nil
	}

	bt, err := client.Call(ctx, api, server.GetAttachmentText, server.DigestInput{BLAKE3: sum})
	if err != nil {
		return err
	}
	if c.JSON {
		return printJSON(bt)
	}
	fmt.Printf("blake3:    %s\nstatus:    %s\nextractor: %s\nchars:     %d\nextracted: %s\n\n",
		bt.BLAKE3, bt.Status, bt.Extractor, bt.Chars, bt.ExtractedAt.Format(time.RFC1123))
	fmt.Println(bt.Text)
	return nil
}

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
	return fmt.Sprintf("%.1f%c", float64(n)/float64(div), "KMGTPE"[exp])
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
