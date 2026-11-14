// Package jobs names the work bank queues in River: the kinds, their
// arguments, queues, uniqueness and attempts. Package worker does the work.
package jobs

import (
	"context"
	"log/slog"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"
)

// OCRQueue is worked only by `bank worker --queue ocr`, in the image that
// carries tesseract.
const OCRQueue = "ocr"

// Text reads one content's text with the in-process extractors.
type Text struct {
	ContentID int64 `json:"content_id"`
}

func (Text) Kind() string { return "text" }

func (Text) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: 3, UniqueOpts: unfinished(true)}
}

// OCR reads one content whose text came back needs_ocr.
type OCR struct {
	ContentID int64 `json:"content_id"`
}

func (OCR) Kind() string { return "ocr" }

func (OCR) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: OCRQueue, MaxAttempts: 3, UniqueOpts: unfinished(true)}
}

// GmailSync pulls new Gmail mail, as `bank sync` does.
type GmailSync struct{}

func (GmailSync) Kind() string { return "gmail_sync" }

func (GmailSync) InsertOpts() river.InsertOpts { return scheduled() }

// InboxSweep imports what waits in the inbox, as `bank import inbox` does.
type InboxSweep struct{}

func (InboxSweep) Kind() string { return "inbox_sweep" }

func (InboxSweep) InsertOpts() river.InsertOpts { return scheduled() }

// scheduled runs once per tick and never beside itself. The next tick is the
// retry.
func scheduled() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: 1, UniqueOpts: unfinished(false)}
}

// unfinished allows one job per kind, or per kind and arguments, until it
// completes or is discarded. River's default also counts completed jobs,
// which would turn away a content cleared for another read, and the next
// periodic run, until the cleaner deletes them a day later.
func unfinished(byArgs bool) river.UniqueOpts {
	return river.UniqueOpts{ByArgs: byArgs, ByState: []rivertype.JobState{
		rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRetryable,
		rivertype.JobStateRunning, rivertype.JobStateScheduled,
	}}
}

// inserter needs no pool: every insert runs in the caller's transaction.
var inserter = sync.OnceValues(func() (*river.Client[pgx.Tx], error) {
	return river.NewClient(riverpgxv5.New(nil), &river.Config{Logger: slog.Default()})
})

// Insert adds jobs in tx, so they exist exactly when the rows that called for
// them commit. A job whose unfinished twin is already queued is skipped.
func Insert(ctx context.Context, tx pgx.Tx, args ...river.JobArgs) error {
	if len(args) == 0 {
		return nil
	}
	client, err := inserter()
	if err != nil {
		return err
	}
	params := make([]river.InsertManyParams, len(args))
	for i, a := range args {
		params[i] = river.InsertManyParams{Args: a}
	}
	_, err = client.InsertManyTx(ctx, tx, params)
	return err
}
