package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/auth"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestCaptureTransaction(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	woken := 0
	s := New(st, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() { woken++ }, auth.Off(), "")
	h := s.Handler()

	device := uuid.Must(uuid.NewV7())
	pv := uuid.Must(uuid.NewV7())
	events, _ := json.Marshal(map[string]any{"device_id": device, "events": []map[string]any{
		{"type": "page_view", "id": pv, "url": "https://example.com/page", "title": "Page",
			"started_at": time.Now().UTC().Format(time.RFC3339), "navigation_type": "load"}}})
	if rec := do(t, h, httptest.NewRequest(http.MethodPost, server+"/v1/events/batch", bytes.NewReader(events))); rec.Code != http.StatusOK {
		t.Fatalf("events: %d %s", rec.Code, rec.Body.String())
	}

	html := []byte("<html><head><title>Page</title></head><body>hello</body></html>")
	post := func() (int, bool) {
		meta := validMeta()
		meta["device_id"], meta["page_view_id"] = device, pv
		meta["browser_title"] = "Pa\x00ge"
		rec := do(t, h, captureRequest(t, meta, html))
		var res struct {
			Deduplicated bool `json:"deduplicated"`
		}
		decode(t, rec, &res)
		return rec.Code, res.Deduplicated
	}
	if code, dedup := post(); code != http.StatusCreated || dedup {
		t.Fatalf("first capture: %d dedup=%v", code, dedup)
	}
	if code, dedup := post(); code != http.StatusCreated || !dedup {
		t.Fatalf("second capture: %d dedup=%v", code, dedup)
	}
	if woken != 1 {
		t.Errorf("workers woken %d times, want once (the duplicate has nothing to extract)", woken)
	}
	stats, err := st.Stats(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if stats.Blobs != 1 || stats.Captures != 2 || stats.Derivations[store.StatusPending] != 1 || stats.PageViews != 1 {
		t.Errorf("blobs=%d captures=%d derivations=%v page_views=%d", stats.Blobs, stats.Captures, stats.Derivations, stats.PageViews)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from urls where host = 'example.com'`); n != 1 {
		t.Errorf("%d urls rows for example.com, want 1", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from captures where browser_title = 'Page'`); n != 2 {
		t.Errorf("%d captures without NUL in their browser title, want 2", n)
	}
}

func TestCaptureOfAnUnknownPageViewIsRefusedAndWritesNothing(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	h := New(st, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() {}, auth.Off(), "").Handler()

	rec := do(t, h, captureRequest(t, validMeta(), []byte("<html><head><title>Page</title></head></html>")))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status %d, want 422: %s", rec.Code, rec.Body.String())
	}
	if n := pgschematest.QueryInt(t, dsn, `select (select count(*) from urls) + (select count(*) from raw_html_blobs)
		+ (select count(*) from captures) + (select count(*) from derivations)`); n != 0 {
		t.Errorf("%d rows written for a refused capture", n)
	}
}
