package ingest

import (
	"bytes"
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
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// Postgres rejects NUL in text. The store strips it so one title cannot fail
// the whole batch.
func TestEventsWithNULInATitleAreStoredWithoutIt(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	h := New(st, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() {}, auth.Off(), "").Handler()

	at := time.Now().UTC().Format(time.RFC3339)
	body, _ := json.Marshal(map[string]any{"device_id": uuid.Must(uuid.NewV7()), "events": []map[string]any{
		{"type": "page_view", "id": uuid.Must(uuid.NewV7()), "url": "https://example.com/page", "title": "Pa\x00ge",
			"started_at": at, "navigation_type": "load"},
		{"type": "span_start", "id": uuid.Must(uuid.NewV7()), "started_at": at, "app_name": "Code",
			"window_title": "main.go\x00 — aqt"},
	}})
	rec := do(t, h, httptest.NewRequest(http.MethodPost, server+"/v1/events/batch", bytes.NewReader(body)))
	var res struct{ Accepted, Dropped int }
	decode(t, rec, &res)
	if rec.Code != http.StatusOK || res.Accepted != 2 || res.Dropped != 0 {
		t.Fatalf("status %d, accepted=%d dropped=%d, want 200 with both accepted", rec.Code, res.Accepted, res.Dropped)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from page_views where title = 'Page'`); n != 1 {
		t.Error("page view title was not stored without its NUL")
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from activity_spans where window_title = 'main.go — aqt'`); n != 1 {
		t.Error("window title was not stored without its NUL")
	}
}
