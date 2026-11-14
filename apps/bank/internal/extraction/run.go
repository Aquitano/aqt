// Package extraction is `bank extract`, the manual extraction pass: it turns
// attachment bytes into searchable text with packages/go/extract and records
// the outcome per content. The job queue reads every new content on its own;
// this pass re-reads a status by hand, or runs the tools on a laptop against
// a remote archive.
package extraction

import (
	"context"
	"fmt"
	"slices"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// Archive is the part of the archive an extraction run touches. `bank
// extract` reaches it through the API, so the same pass runs on the server or
// on a laptop against a remote `bank serve`, the laptop being where a heavier
// OCR model would live. Storing text also updates the messages that carry it.
type Archive interface {
	ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error)
	PutBlobText(ctx context.Context, bt store.BlobText) error
	// OpenBlob makes the bytes available as a local file, because every
	// extractor here either seeks or is a subprocess taking a path.
	OpenBlob(ctx context.Context, d content.Digest) (path string, cleanup func(), err error)
}

// Selection is which content a run should work on.
type Selection struct {
	// Statuses defaults to the pending ones, plus needs_ocr when OCR is on.
	// Naming a status re-runs exactly it: failed after a bug is fixed,
	// unsupported after an extractor is added.
	Statuses []string
	Source   string
	Limit    int
}

// Summary is what a run did, in the shape `--json` prints.
type Summary struct {
	Considered int            `json:"considered"`
	ByStatus   map[string]int `json:"by_status"`
	Chars      int64          `json:"chars_extracted"`
	// Errors keeps the first few failures. A run over thousands of blobs
	// should report what broke without printing a wall of it.
	Errors []string `json:"errors,omitempty"`
}

const maxReportedErrors = 10

// defaultStatuses picks what an unqualified run works on. Asking for OCR has
// to imply the files that need it, or the obvious command does nothing and the
// useful one is an incantation. An explicit selection is never widened.
func defaultStatuses(named []string, ocr bool) []string {
	if len(named) > 0 {
		return named
	}
	if ocr {
		return []string{store.StatusPending, string(extract.StatusNeedsOCR)}
	}
	return []string{store.StatusPending}
}

// Run extracts text for the selected content. Individual failures are
// recorded against their blob and the run continues; only a broken archive
// aborts it.
func Run(ctx context.Context, a Archive, sel Selection, o extract.Options, progress func(store.BlobRef, extract.Result)) (Summary, error) {
	sum := Summary{ByStatus: map[string]int{}}
	if o.OCR {
		if err := extract.OCRAvailable(o); err != nil {
			return sum, err
		}
	}
	statuses := defaultStatuses(sel.Statuses, o.OCR)
	blobs, err := a.ListBlobs(ctx, store.ListBlobsOpts{Statuses: statuses, Source: sel.Source, Limit: sel.Limit})
	if err != nil {
		return sum, err
	}
	// Manual text is dropped here as well as refused by the CLI flag, because
	// this is the last point before it would be overwritten and a hand-made
	// transcription is the one kind of text nothing can rebuild.
	blobs = slices.DeleteFunc(blobs, func(b store.BlobRef) bool {
		return b.Status == string(extract.StatusManual)
	})
	sum.Considered = len(blobs)

	for _, b := range blobs {
		if err := ctx.Err(); err != nil {
			return sum, err
		}
		res := extractOne(ctx, a, b, o)
		status := res.Stored()
		if err := a.PutBlobText(ctx, store.BlobText{
			BLAKE3:    b.BLAKE3,
			Text:      res.Text,
			Extractor: res.Extractor,
			Status:    string(status),
		}); err != nil {
			return sum, fmt.Errorf("record %s: %w", short(b.BLAKE3), err)
		}
		sum.ByStatus[string(status)]++
		sum.Chars += int64(len(res.Text))
		if res.Err != nil && len(sum.Errors) < maxReportedErrors {
			sum.Errors = append(sum.Errors, fmt.Sprintf("%s (%s): %v", b.Filename, short(b.BLAKE3), res.Err))
		}
		if progress != nil {
			progress(b, res)
		}
	}
	return sum, nil
}

func extractOne(ctx context.Context, a Archive, b store.BlobRef, o extract.Options) extract.Result {
	path, cleanup, err := a.OpenBlob(ctx, b.BLAKE3)
	if err != nil {
		return extract.Result{Status: extract.StatusFailed, Err: err}
	}
	defer cleanup()
	return extract.File(ctx, path, b.Filename, b.MimeType, o)
}

func short(d content.Digest) string {
	return d.String()[:12]
}
