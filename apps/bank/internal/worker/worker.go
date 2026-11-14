// Package worker does the work package jobs names: reading text out of
// contents, OCR, and the scheduled Gmail sync and inbox sweep.
package worker

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/aquitano/aqt/apps/bank/internal/collect/gmail"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/jobs"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

// Deps is what the workers read and write.
type Deps struct {
	Target  importer.Target
	DataDir string
	// TempDir stages OCR's rasterized pages.
	TempDir string
	OCRLang string
}

// defaultWorkers bounds the default queue, which the server's memory limit
// shares with requests.
const defaultWorkers = 4

// A sync or sweep can import a whole Takeout. The rescuer must not take one
// for stuck while it still runs.
const (
	scheduledTimeout = 3 * time.Hour
	rescueAfter      = scheduledTimeout + time.Hour
)

// Serve works the default queue and enqueues the scheduled jobs, for bank
// serve.
func Serve(pool *pgxpool.Pool, d Deps) (*river.Client[pgx.Tx], error) {
	return newClient(pool, d, &river.Config{
		Queues: map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: defaultWorkers}},
		PeriodicJobs: []*river.PeriodicJob{
			every(time.Hour, jobs.GmailSync{}),
			every(15*time.Minute, jobs.InboxSweep{}),
		},
	}, extract.File)
}

// Queue works one queue for bank worker. The schedule, retries and cleanup
// stay with bank serve, which is the only client that can lead.
func Queue(pool *pgxpool.Pool, d Deps, queue string, workers int) (*river.Client[pgx.Tx], error) {
	return newClient(pool, d, &river.Config{
		Queues:                 map[string]river.QueueConfig{queue: {MaxWorkers: workers}},
		LeaderElectionDisabled: true,
	}, extract.File)
}

func every(interval time.Duration, args river.JobArgs) *river.PeriodicJob {
	return river.NewPeriodicJob(river.PeriodicInterval(interval),
		func() (river.JobArgs, *river.InsertOpts) { return args, nil },
		&river.PeriodicJobOpts{ID: args.Kind(), RunOnStart: true})
}

type extractFunc func(ctx context.Context, path, filename, mimeType string, o extract.Options) extract.Result

func newClient(pool *pgxpool.Pool, d Deps, config *river.Config, read extractFunc) (*river.Client[pgx.Tx], error) {
	o := extract.DefaultOptions()
	o.TempDir = d.TempDir
	o.OCRLang = cmp.Or(d.OCRLang, o.OCRLang)
	r := reader{store: d.Target.Store, path: d.Target.Blobs.Path, options: o, extract: read}
	workers := river.NewWorkers()
	river.AddWorker(workers, &textWorker{reader: r})
	river.AddWorker(workers, &ocrWorker{reader: r})
	river.AddWorker(workers, &gmailWorker{target: d.Target, dataDir: d.DataDir})
	river.AddWorker(workers, &inboxWorker{target: d.Target, dir: filepath.Join(d.DataDir, "inbox")})
	config.Workers = workers
	config.Logger = slog.Default()
	config.ErrorHandler = logErrors{}
	config.RescueStuckJobsAfter = rescueAfter
	return river.NewClient(riverpgxv5.New(pool), config)
}

// Run works the client's queues while serve runs. When ctx ends the client
// stops fetching, and running jobs get drain to finish before their contexts
// are cancelled. Run returns once both are done, so the caller can close the
// pool.
func Run(ctx context.Context, c *river.Client[pgx.Tx], drain time.Duration, serve func(context.Context) error) error {
	if err := c.Start(context.WithoutCancel(ctx)); err != nil {
		return err
	}
	serveCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopped := make(chan error, 1)
	go func() {
		<-serveCtx.Done()
		stopped <- stop(c, drain)
	}()
	err := serve(serveCtx)
	cancel()
	return errors.Join(err, <-stopped)
}

func stop(c *river.Client[pgx.Tx], drain time.Duration) error {
	soft, cancel := context.WithTimeout(context.Background(), drain)
	defer cancel()
	if err := c.Stop(soft); !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	hard, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.StopAndCancel(hard)
}

type logErrors struct{}

func (logErrors) HandleError(ctx context.Context, job *rivertype.JobRow, err error) *river.ErrorHandlerResult {
	slog.ErrorContext(ctx, "job failed", "kind", job.Kind, "job", job.ID,
		"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", err)
	return nil
}

func (logErrors) HandlePanic(ctx context.Context, job *rivertype.JobRow, panicVal any, trace string) *river.ErrorHandlerResult {
	slog.ErrorContext(ctx, "job panicked", "kind", job.Kind, "job", job.ID,
		"attempt", job.Attempt, "panic", fmt.Sprint(panicVal), "trace", trace)
	return nil
}

// reader extracts one content's text and stores it.
type reader struct {
	store   *store.Store
	path    func(content.Digest) string
	options extract.Options
	extract extractFunc
}

// readTimeout leaves room past extract's own bound on one document.
func (r reader) readTimeout() time.Duration { return r.options.Timeout + time.Minute }

var errUnreadable = errors.New("the extractor gave no reason")

// read extracts the content's text if it is still in the state the job was
// queued for, and stores it. A failure or a panic is returned for River to
// retry; on the last attempt the content is recorded as failed, so it leaves
// the queue visibly instead of silently.
func (r reader) read(ctx context.Context, job *rivertype.JobRow, contentID int64, waiting string, ocr bool) (err error) {
	subject, err := r.store.TextSubject(ctx, contentID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if subject.Status != waiting {
		return nil
	}
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("extractor panicked: %v\n%s", p, debug.Stack())
		}
		if err != nil && job.Attempt >= job.MaxAttempts {
			err = errors.Join(err, r.store.PutBlobText(context.WithoutCancel(ctx), store.BlobText{
				BLAKE3: subject.BLAKE3, Status: string(extract.StatusFailed),
			}))
		}
	}()
	o := r.options
	o.OCR = ocr
	res := r.extract(ctx, r.path(subject.BLAKE3), subject.Filename, subject.MimeType, o)
	if res.Status == extract.StatusFailed {
		return fmt.Errorf("read %s: %w", subject.Filename, cmp.Or(res.Err, errUnreadable))
	}
	return r.store.PutBlobText(ctx, store.BlobText{
		BLAKE3: subject.BLAKE3, Text: res.Text, Extractor: res.Extractor, Status: string(res.Stored()),
	})
}

type textWorker struct {
	river.WorkerDefaults[jobs.Text]
	reader
}

func (w *textWorker) Work(ctx context.Context, job *river.Job[jobs.Text]) error {
	return w.read(ctx, job.JobRow, job.Args.ContentID, store.StatusPending, false)
}

func (w *textWorker) Timeout(*river.Job[jobs.Text]) time.Duration { return w.readTimeout() }

type ocrWorker struct {
	river.WorkerDefaults[jobs.OCR]
	reader
}

func (w *ocrWorker) Work(ctx context.Context, job *river.Job[jobs.OCR]) error {
	return w.read(ctx, job.JobRow, job.Args.ContentID, string(extract.StatusNeedsOCR), true)
}

func (w *ocrWorker) Timeout(*river.Job[jobs.OCR]) time.Duration { return w.readTimeout() }

type gmailWorker struct {
	river.WorkerDefaults[jobs.GmailSync]
	target  importer.Target
	dataDir string
}

func (w *gmailWorker) Work(ctx context.Context, _ *river.Job[jobs.GmailSync]) error {
	if !gmail.Authorized(w.dataDir) {
		return nil
	}
	res, err := gmail.Sync(ctx, w.target, w.dataDir, false)
	slog.InfoContext(ctx, "gmail sync", "mode", res.Mode, "new", res.Inserted, "known", res.Duplicates,
		"attachments", res.Attachments, "failed", res.Failed, "skipped", res.Quarantined)
	return err
}

func (w *gmailWorker) Timeout(*river.Job[jobs.GmailSync]) time.Duration { return scheduledTimeout }

type inboxWorker struct {
	river.WorkerDefaults[jobs.InboxSweep]
	target importer.Target
	dir    string
}

func (w *inboxWorker) Work(ctx context.Context, _ *river.Job[jobs.InboxSweep]) error {
	res, err := importer.SweepInbox(ctx, w.target, w.dir)
	for _, warning := range res.Warnings {
		slog.WarnContext(ctx, "inbox sweep", "warning", warning)
	}
	if len(res.Files) > 0 {
		slog.InfoContext(ctx, "inbox sweep", "imported", res.Imported, "known", res.Duplicates,
			"rejected", res.Rejected, "failed", res.Failed, "settling", res.Settling)
	}
	return err
}

func (w *inboxWorker) Timeout(*river.Job[jobs.InboxSweep]) time.Duration { return scheduledTimeout }
