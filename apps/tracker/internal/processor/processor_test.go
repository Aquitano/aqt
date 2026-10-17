package processor

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/fake"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

const fakeVersion = 1

func init() {
	extractor.Register(fake.Extractor{Version: fakeVersion})
}

const pageHTML = `<html><head><title>Bun ORM</title></head><body><h1>Bun</h1><p>SQL-first Golang ORM for PostgreSQL.</p></body></html>`

func newProcessor(t *testing.T) (*Processor, *store.Store, string) {
	t.Helper()
	st, dsn := storetest.NewNamed(t)
	return New(st, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), 1), st, dsn
}

func ingest(t *testing.T, st *store.Store, pageURL, html string) store.CaptureResult {
	t.Helper()
	return ingestAt(t, st, pageURL, html, time.Now())
}

func ingestAt(t *testing.T, st *store.Store, pageURL, html string, capturedAt time.Time) store.CaptureResult {
	t.Helper()
	ctx := context.Background()
	normalized, host, err := urlnorm.Normalize(pageURL)
	if err != nil {
		t.Fatal(err)
	}
	key := store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host}
	device := uuid.Must(uuid.NewV7())
	pv := uuid.Must(uuid.NewV7())
	if _, err := st.ApplyEvents(ctx, device, store.Events{PageViews: []store.PageViewEvent{
		{ID: pv, URL: key, StartedAt: time.Now(), NavigationType: "load"}}}); err != nil {
		t.Fatal(err)
	}
	raw := []byte(html)
	hash := blob.Hash(raw)
	payload := blob.Compress(raw)
	res, err := st.InsertCapture(ctx, store.CaptureInput{
		Capture: store.Capture{ID: uuid.Must(uuid.NewV7()), PageViewID: pv, DeviceID: device, RawHash: hash[:],
			Extractor: fake.Name, CapturedAt: capturedAt, Reason: "initial", URL: pageURL},
		URL:     key,
		Blob:    store.RawHTMLBlob{Hash: hash[:], Codec: blob.CodecZstd, RawBytes: len(raw), StoredBytes: len(payload), Payload: payload},
		Version: fakeVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func drain(t *testing.T, p *Processor) int {
	t.Helper()
	n := 0
	for {
		busy, err := p.RunOnce(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !busy {
			return n
		}
		n++
	}
}

func TestSameHTMLTwiceYieldsOneBlobOneDerivationOneRecord(t *testing.T) {
	p, st, _ := newProcessor(t)
	first := ingest(t, st, "https://example.com/bun?utm_source=x", pageHTML)
	second := ingest(t, st, "https://example.com/bun", pageHTML)
	if first.Deduplicated || !second.Deduplicated {
		t.Fatalf("dedup flags: first=%v second=%v", first.Deduplicated, second.Deduplicated)
	}
	if n := drain(t, p); n != 1 {
		t.Errorf("processed %d derivations, want 1", n)
	}
	stats, err := st.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Blobs != 1 || stats.Captures != 2 || stats.Derivations[store.StatusDone] != 1 || stats.Records[fake.Name] != 1 {
		t.Errorf("blobs=%d captures=%d derivations=%v records=%v", stats.Blobs, stats.Captures, stats.Derivations, stats.Records)
	}
	hits, err := st.Search(context.Background(), store.SearchOpts{Query: "postgresql", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Title != "Bun ORM" || !strings.Contains(hits[0].Snippet, "PostgreSQL") {
		t.Errorf("search hits = %+v", hits)
	}
}

func TestAPageKeepsOneRecordWithItsNewestContent(t *testing.T) {
	type capture struct {
		at    time.Time
		title string
	}
	open := capture{time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC), "open"}
	closed := capture{open.at.Add(time.Hour), "closed"}
	for name, order := range map[string][]capture{
		"in capture order":   {open, closed},
		"older blob replays": {closed, open},
	} {
		t.Run(name, func(t *testing.T) {
			p, st, dsn := newProcessor(t)
			for _, c := range order {
				ingestAt(t, st, "https://example.com/issues/1", strings.Replace(pageHTML, "Bun ORM", c.title, 1), c.at)
				drain(t, p)
			}
			if n := pgschematest.QueryInt(t, dsn, `select count(*) from records`); n != 1 {
				t.Fatalf("%d records for one page, want 1", n)
			}
			if n := pgschematest.QueryInt(t, dsn, `select count(*) from records
				where title = $1 and first_seen_at = $2 and last_seen_at = $3`, closed.title, open.at, closed.at); n != 1 {
				t.Error("the record does not hold the newest content over the whole seen window")
			}
		})
	}
}

func TestQueueCapturesRefillsTheQueueFromCaptures(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/bun", pageHTML)
	ingest(t, st, "https://example.com/other", strings.Replace(pageHTML, "Bun ORM", "Other", 1))
	pgschematest.QueryInt(t, dsn, `with gone as (delete from derivations returning 1) select count(*) from gone`)

	ctx := context.Background()
	targets := []store.ExtractorVersion{{Name: fake.Name, Version: fakeVersion}}
	if queued, err := st.QueueCaptures(ctx, targets); err != nil || queued != 2 {
		t.Fatalf("queued %d (%v), want 2", queued, err)
	}
	if queued, err := st.QueueCaptures(ctx, targets); err != nil || queued != 0 {
		t.Errorf("a second run queued %d (%v), want 0", queued, err)
	}
	if n := drain(t, p); n != 2 {
		t.Errorf("processed %d, want 2", n)
	}
}

func TestNULInExtractedTextIsDroppedRatherThanFailingTheJob(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/nul", `<html><head><title>Bun\0 ORM</title></head><body><p>SQL\0-first</p></body></html>`)
	drain(t, p)
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from records
		where title = 'Bun ORM' and search_text = 'SQL-first' and data->>'title' = 'Bun ORM'`); n != 1 {
		t.Error("the record was not stored without its NULs")
	}
}

func TestReprocessAllRebuildsDerivedTablesFromSource(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/bun", pageHTML)
	ingest(t, st, "https://example.com/other", strings.Replace(pageHTML, "Bun ORM", "Other", 1))
	drain(t, p)
	before := pgschematest.QueryInt(t, dsn, `select min(id) from records where title = 'Bun ORM'`)

	ctx := context.Background()
	queued, err := st.Reprocess(ctx, store.ReprocessOpts{All: true, Targets: []store.ExtractorVersion{{Name: fake.Name, Version: fakeVersion}}})
	if err != nil {
		t.Fatal(err)
	}
	if queued != 2 {
		t.Errorf("queued %d, want 2", queued)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from records`); n != 0 {
		t.Fatalf("%d records survived the wipe", n)
	}
	if n := drain(t, p); n != 2 {
		t.Errorf("processed %d, want 2", n)
	}
	stats, err := st.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Derivations[store.StatusDone] != 2 || stats.Records[fake.Name] != 2 {
		t.Errorf("derivations=%v records=%v", stats.Derivations, stats.Records)
	}
	after := pgschematest.QueryInt(t, dsn, `select min(id) from records where title = 'Bun ORM'`)
	if after == before {
		t.Error("the record was not rebuilt")
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from derivations d join records r on r.id = d.record_id
		where r.record_hash = (select record_hash from records where title = 'Bun ORM')`); n != 1 {
		t.Errorf("rebuilt derivation does not point at the rebuilt record (%d)", n)
	}
}

func TestReprocessAfterAVersionBumpReplacesTheOldRecords(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/bun", pageHTML)
	drain(t, p)
	// Pretend the record came from an older version whose output differed.
	pgschematest.QueryInt(t, dsn, `with old as (
		update derivations set extractor_version = $1 returning 1),
		changed as (update records set record_hash = '\x00', data = '{"old": true}' returning 1)
		select (select count(*) from old) + (select count(*) from changed)`, fakeVersion-1)

	queued, err := st.Reprocess(context.Background(), store.ReprocessOpts{
		Targets: []store.ExtractorVersion{{Name: fake.Name, Version: fakeVersion}}})
	if err != nil || queued != 1 {
		t.Fatalf("reprocess queued %d (%v), want 1", queued, err)
	}
	drain(t, p)
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from records`); n != 1 {
		t.Errorf("%d records after the rollout, want the new one only", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from derivations where extractor_version <> $1`, fakeVersion); n != 0 {
		t.Errorf("%d derivations of the old version survived", n)
	}
}

func TestAJobWhoseWorkerKeepsDyingIsFailedNotReclaimed(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/bun", pageHTML)
	pgschematest.QueryInt(t, dsn, `with quiet as (
		update derivations set status = 'running', claimed_at = now() - interval '1 hour', attempts = $1
		returning 1) select count(*) from quiet`, store.MaxAttempts)

	if n := drain(t, p); n != 0 {
		t.Errorf("claimed %d jobs, want none", n)
	}
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from derivations where status = 'failed' and error_class = $1`, store.ClassAbandoned); n != 1 {
		t.Errorf("the abandoned job was not failed (%d rows)", n)
	}
}

func TestFailuresAreClassifiedAndRetriedByPolicy(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/empty", `<html><body>no title here</body></html>`)
	ingest(t, st, "https://example.com/boom", `<html><head><title>panic</title></head></html>`)

	for range store.MaxAttempts {
		drain(t, p)
		retryNow(t, dsn)
	}
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from derivations where status = 'failed' and error_class = 'no_match' and attempts = 1`); n != 1 {
		t.Errorf("no_match should fail on the first attempt without retries (%d rows)", n)
	}
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from derivations where status = 'failed' and error_class = 'panic' and attempts = $1`, store.MaxAttempts); n != 1 {
		t.Errorf("panic should be retried up to %d attempts and then fail (%d rows)", store.MaxAttempts, n)
	}
	pgschematest.QueryInt(t, dsn, `with delayed as (update derivations set retry_at = now() + interval '1 hour' returning 1) select count(*) from delayed`)
	queued, err := st.Reprocess(context.Background(), store.ReprocessOpts{Failed: true,
		Targets: []store.ExtractorVersion{{Name: fake.Name, Version: fakeVersion}}})
	if err != nil || queued != 2 {
		t.Errorf("reprocess --failed queued %d (%v), want 2", queued, err)
	}
	if n := drain(t, p); n != 2 {
		t.Errorf("reprocess --failed made %d jobs due, want 2", n)
	}
}

func TestARetriedJobWaitsTwiceAsLongAfterEachFailure(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/boom", `<html><head><title>panic</title></head></html>`)

	var waits []int64
	for range store.MaxAttempts - 1 {
		if n := drain(t, p); n != 1 {
			t.Fatalf("processed %d jobs, want the one due", n)
		}
		if n := drain(t, p); n != 0 {
			t.Fatal("a failed job was claimed again before its backoff passed")
		}
		waits = append(waits, pgschematest.QueryInt(t, dsn,
			`select round(extract(epoch from retry_at - updated_at))::bigint from derivations where status = 'pending'`))
		retryNow(t, dsn)
	}
	if want := []int64{60, 120, 240, 480}; !slices.Equal(waits, want) {
		t.Errorf("waits = %v s, want %v", waits, want)
	}
}

func TestAStoreErrorBeforeExtractionIsRetriedAsStore(t *testing.T) {
	p, st, dsn := newProcessor(t)
	ingest(t, st, "https://example.com/bun", pageHTML)
	pgschematest.QueryInt(t, dsn, `with gone as (delete from captures returning 1) select count(*) from gone`)

	drain(t, p)
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from derivations where status = 'pending' and error_class = 'store'`); n != 1 {
		t.Error("a job whose captures could not be read was not retried as a store failure")
	}
}

// retryNow makes every backed-off job due, as if its wait had passed.
func retryNow(t *testing.T, dsn string) {
	t.Helper()
	pgschematest.QueryInt(t, dsn, `with due as (update derivations set retry_at = now() where retry_at > now()
		returning 1) select count(*) from due`)
}
