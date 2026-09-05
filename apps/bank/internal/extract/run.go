package extract

import (
	"context"
	"fmt"
	"slices"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Archive is the part of the archive an extraction run touches. The local
// Postgres store and the HTTP client both satisfy it, which is what lets the
// same pass run on the server or on a laptop against a remote `bank serve` —
// the laptop being where a heavier OCR model would live.
type Archive interface {
	ListBlobs(ctx context.Context, o store.ListBlobsOpts) ([]store.BlobRef, error)
	PutBlobText(ctx context.Context, bt store.BlobText) error
	RefreshAttachmentText(ctx context.Context) (int64, error)
	// OpenBlob makes the bytes available as a local file, because every
	// extractor here either seeks or is a subprocess taking a path.
	OpenBlob(ctx context.Context, sha256 string) (path string, cleanup func(), err error)
}

// Selection is which content a run should work on.
type Selection struct {
	// Statuses defaults to the pending ones, plus needs_ocr when OCR is on.
	// Naming a status re-runs exactly it: failed after a bug is fixed,
	// unsupported after an extractor is added.
	Statuses []string
	Source   string
	Limit    int
	// NewestFirst works on the most recently attached content first instead of
	// the largest. The post-import pass sets it: what just landed has to be
	// searchable now, and with a backlog of large pending blobs the default
	// order would spend the whole batch before reaching it.
	NewestFirst bool
}

// Summary is what a run did, in the shape `--json` prints.
type Summary struct {
	Considered int            `json:"considered"`
	ByStatus   map[string]int `json:"by_status"`
	Chars      int64          `json:"chars_extracted"`
	Reindexed  int64          `json:"messages_reindexed"`
	// Errors keeps the first few failures. A run over thousands of blobs
	// should report what broke without printing a wall of it.
	Errors []string `json:"errors,omitempty"`
}

const maxReportedErrors = 10

// PostImportLimit bounds the batch an import reads, so importing three files
// into an archive with a large unextracted backlog stays quick — and so an
// upload cannot end up extracting a whole backlog while the client waits.
// Whatever is left over is what a full `bank extract` is for.
const PostImportLimit = 200

// defaultStatuses picks what an unqualified run works on. Asking for OCR has
// to imply the files that need it, or the obvious command does nothing and the
// useful one is an incantation. An explicit selection is never widened.
func defaultStatuses(named []string, ocr bool) []string {
	if len(named) > 0 {
		return named
	}
	if ocr {
		return []string{store.StatusPending, string(StatusNeedsOCR)}
	}
	return []string{store.StatusPending}
}

// Run extracts text for the selected content and reindexes the messages that
// carry it. Individual failures are recorded against their blob and the run
// continues; only a broken archive aborts it.
func Run(ctx context.Context, a Archive, sel Selection, o Options, progress func(store.BlobRef, Result)) (Summary, error) {
	sum := Summary{ByStatus: map[string]int{}}
	if o.OCR {
		if err := OCRAvailable(o); err != nil {
			return sum, err
		}
	}
	statuses := defaultStatuses(sel.Statuses, o.OCR)
	blobs, err := a.ListBlobs(ctx, store.ListBlobsOpts{
		Statuses:    statuses,
		Source:      sel.Source,
		Limit:       sel.Limit,
		NewestFirst: sel.NewestFirst,
	})
	if err != nil {
		return sum, err
	}
	// Manual text is dropped here as well as refused by the CLI flag, because
	// this is the last point before it would be overwritten and a hand-made
	// transcription is the one kind of text nothing can rebuild.
	blobs = slices.DeleteFunc(blobs, func(b store.BlobRef) bool {
		return b.Status == string(StatusManual)
	})
	sum.Considered = len(blobs)

	for _, b := range blobs {
		if err := ctx.Err(); err != nil {
			return sum, err
		}
		res := extractOne(ctx, a, b, o)
		if err := a.PutBlobText(ctx, store.BlobText{
			SHA256:    b.SHA256,
			Text:      res.Text,
			Extractor: res.Extractor,
			Status:    string(res.Status),
		}); err != nil {
			return sum, fmt.Errorf("record %s: %w", short(b.SHA256), err)
		}
		sum.ByStatus[string(res.Status)]++
		sum.Chars += int64(len(res.Text))
		if res.Err != nil && len(sum.Errors) < maxReportedErrors {
			sum.Errors = append(sum.Errors, fmt.Sprintf("%s (%s): %v", b.Filename, short(b.SHA256), res.Err))
		}
		if progress != nil {
			progress(b, res)
		}
	}

	// Always refresh, even when nothing was extracted: a message imported
	// after its attachment's text was already known still needs the text
	// copied onto its row.
	if sum.Reindexed, err = a.RefreshAttachmentText(ctx); err != nil {
		return sum, err
	}
	return sum, nil
}

func extractOne(ctx context.Context, a Archive, b store.BlobRef, o Options) Result {
	path, cleanup, err := a.OpenBlob(ctx, b.SHA256)
	if err != nil {
		return Result{Status: StatusFailed, Err: err}
	}
	defer cleanup()
	return File(ctx, path, b.Filename, b.MimeType, o)
}

func short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
