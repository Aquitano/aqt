package worker

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertest"
	"github.com/riverqueue/river/rivertype"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/jobs"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/extract"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

type archive struct {
	st     *store.Store
	dsn    string
	deps   Deps
	driver *riverpgxv5.Driver
}

func newArchive(t *testing.T) archive {
	t.Helper()
	st, dsn := storetest.NewNamed(t)
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return archive{st: st, dsn: dsn, driver: riverpgxv5.New(storetest.Pool(t, dsn)),
		deps: Deps{Target: importer.Target{Store: st, Blobs: blobs}, DataDir: t.TempDir(), TempDir: t.TempDir()}}
}

// attach stores a message carrying filename's bytes, which queues its text job.
func (a archive) attach(t *testing.T, filename string) content.Digest {
	t.Helper()
	d := content.Sum([]byte(filename))
	_, err := a.st.WriteMessages(context.Background(), []store.Record{{
		Message:     store.Message{Source: "proton", ExternalID: filename, Sender: "alice@example.com", Body: "attached"},
		Attachments: []store.Attachment{{Filename: filename, SizeBytes: 1, BLAKE3: d}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func (a archive) status(t *testing.T, d content.Digest) string {
	t.Helper()
	bt, err := a.st.GetBlobText(context.Background(), d)
	if err != nil {
		t.Fatal(err)
	}
	return bt.Status
}

// run starts a client on queue, retrying failed jobs at once, and returns the
// events of the jobs it finishes.
func (a archive) run(t *testing.T, queue string, read extractFunc) <-chan *river.Event {
	t.Helper()
	client, err := newClient(storetest.Pool(t, a.dsn), a.deps, &river.Config{
		Queues:      map[string]river.QueueConfig{queue: {MaxWorkers: 2}},
		RetryPolicy: retryNow{},
		TestOnly:    true,
	}, read)
	if err != nil {
		t.Fatal(err)
	}
	events, cancel := client.Subscribe(river.EventKindJobCompleted, river.EventKindJobFailed)
	t.Cleanup(cancel)
	if err := client.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return events
}

type retryNow struct{}

func (retryNow) NextRetry(*rivertype.JobRow) time.Time { return time.Now() }

// finished waits until n jobs reached a final state.
func finished(t *testing.T, events <-chan *river.Event, n int) []*rivertype.JobRow {
	t.Helper()
	var done []*rivertype.JobRow
	timeout := time.After(30 * time.Second)
	for len(done) < n {
		select {
		case e := <-events:
			if e.Job.State == rivertype.JobStateCompleted || e.Job.State == rivertype.JobStateDiscarded {
				done = append(done, e.Job)
			}
		case <-timeout:
			t.Fatalf("%d of %d jobs finished", len(done), n)
		}
	}
	return done
}

func readAs(text string) extractFunc {
	return func(context.Context, string, string, string, extract.Options) extract.Result {
		return extract.Result{Status: extract.StatusOK, Text: text, Extractor: "test"}
	}
}

// A panicking extractor costs its own job, which ends as failed text, while the
// worker goes on to read the next content.
func TestAPanicFailsOnlyItsOwnJob(t *testing.T) {
	a := newArchive(t)
	boom, fine := a.attach(t, "boom.pdf"), a.attach(t, "fine.txt")
	events := a.run(t, river.QueueDefault, func(ctx context.Context, path, filename, mimeType string, o extract.Options) extract.Result {
		if filename == "boom.pdf" {
			panic("corrupt cross-reference table")
		}
		return readAs("longbourn")(ctx, path, filename, mimeType, o)
	})

	discarded := 0
	for _, job := range finished(t, events, 2) {
		if job.State == rivertype.JobStateDiscarded {
			discarded++
		}
	}
	if discarded != 1 {
		t.Errorf("%d jobs failed for good, want the panicking one", discarded)
	}
	if got := a.status(t, boom); got != string(extract.StatusFailed) {
		t.Errorf("panicking content is %s, want failed", got)
	}
	if got := a.status(t, fine); got != string(extract.StatusOK) {
		t.Errorf("the other content is %s, want ok", got)
	}
	queues, err := a.st.QueueStats(context.Background())
	if err != nil || len(queues) != 1 || queues[0].Failed != 1 {
		t.Fatalf("queue stats %+v, %v; want the failed job counted", queues, err)
	}
}

// needs_ocr goes to the ocr queue, which only a worker on that queue reads.
func TestNeedsOCRWaitsForTheOCRQueue(t *testing.T) {
	ctx := context.Background()
	a := newArchive(t)
	scan := a.attach(t, "scan.png")
	events := a.run(t, river.QueueDefault, func(context.Context, string, string, string, extract.Options) extract.Result {
		return extract.Result{Status: extract.StatusNeedsOCR}
	})
	finished(t, events, 1)
	job := rivertest.RequireInserted(ctx, t, a.driver, jobs.OCR{}, &rivertest.RequireInsertedOpts{Queue: jobs.OCRQueue})
	if job.State != rivertype.JobStateAvailable {
		t.Fatalf("ocr job is %s; the default queue's worker took it", job.State)
	}

	ocr := a.run(t, jobs.OCRQueue, func(_ context.Context, _, _, _ string, o extract.Options) extract.Result {
		if !o.OCR {
			t.Error("the ocr worker read without OCR")
		}
		return extract.Result{Status: extract.StatusOK, Text: "rosings parsonage", Extractor: "tesseract"}
	})
	finished(t, ocr, 1)
	if got := a.status(t, scan); got != string(extract.StatusOK) {
		t.Fatalf("scan is %s after OCR", got)
	}
	if n := pgschematest.QueryInt(t, a.dsn, `select count(*) from texts where content_id @@@ paradedb.match('text', 'parsonage')`); n != 1 {
		t.Fatal("the OCR text is not searchable")
	}
}

// Text typed in while a job reads the same content stays: the job's result is
// the one that loses.
func TestManualTextSurvivesAJob(t *testing.T) {
	ctx := context.Background()
	a := newArchive(t)
	d := a.attach(t, "letter.pdf")
	events := a.run(t, river.QueueDefault, func(context.Context, string, string, string, extract.Options) extract.Result {
		if err := a.st.PutBlobText(ctx, store.BlobText{BLAKE3: d, Text: "transcribed by hand", Status: string(extract.StatusManual)}); err != nil {
			t.Error(err)
		}
		return extract.Result{Status: extract.StatusOK, Text: "garbled ocr"}
	})
	finished(t, events, 1)
	bt, err := a.st.GetBlobText(ctx, d)
	if err != nil || bt.Status != string(extract.StatusManual) || bt.Text != "transcribed by hand" {
		t.Fatalf("text = %+v, %v; want the manual transcription", bt, err)
	}
}
