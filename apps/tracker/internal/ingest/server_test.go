package ingest

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/auth"
	"github.com/aquitano/aqt/apps/tracker/internal/authtest"
	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor/fake"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

const fakeMaxBytes = 4096

func init() {
	extractor.Register(fake.Extractor{Version: 1, MaxBytes: fakeMaxBytes})
}

type fakeStore struct {
	events   store.Events
	captures []store.CaptureInput
	dedup    bool
}

func (f *fakeStore) Ping(context.Context) error { return nil }

func (f *fakeStore) ApplyEvents(_ context.Context, _ uuid.UUID, ev store.Events) (store.EventResult, error) {
	f.events = ev
	res := store.EventResult{Accepted: map[string]int{}, Dropped: map[string]int{}}
	res.Accepted[store.EventPageView] = len(ev.PageViews)
	res.Dropped[store.EventSpanStart] = len(ev.SpanStarts)
	return res, nil
}

func (f *fakeStore) InsertCapture(_ context.Context, in store.CaptureInput) (store.CaptureResult, error) {
	f.captures = append(f.captures, in)
	return store.CaptureResult{CaptureID: in.Capture.ID, RawHash: in.Blob.Hash, Deduplicated: f.dedup}, nil
}

func (f *fakeStore) Search(context.Context, store.SearchOpts) ([]store.Hit, error) {
	return []store.Hit{}, nil
}

func (f *fakeStore) Stats(context.Context) (store.Stats, error) {
	return store.Stats{Derivations: map[string]int64{}, Records: map[string]int64{}}, nil
}

func newServer(t *testing.T) (*Server, *fakeStore) {
	t.Helper()
	fs := &fakeStore{}
	return New(fs, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() {}, auth.Off()), fs
}

func do(t *testing.T, h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
}

func TestOriginPolicy(t *testing.T) {
	s, _ := newServer(t)
	h := s.Handler()

	req := httptest.NewRequest(http.MethodGet, "/v1/capture-rules", nil)
	req.Header.Set("Origin", "https://evil.example")
	if rec := do(t, h, req); rec.Code != http.StatusForbidden {
		t.Errorf("web origin: status %d, want 403", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/capture-rules", nil)
	req.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	rec := do(t, h, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abcdefghijklmnop" {
		t.Errorf("extension origin: status %d, allow-origin %q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}
	var rules struct {
		Rules []extractor.Rule `json:"rules"`
	}
	decode(t, rec, &rules)
	if len(rules.Rules) != 1 || rules.Rules[0].Extractor != fake.Name || rules.Rules[0].DwellMS != extractor.DefaultDwellMS {
		t.Errorf("rules = %+v", rules.Rules)
	}

	req = httptest.NewRequest(http.MethodOptions, "/v1/captures", nil)
	req.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec = do(t, h, req)
	if rec.Code != http.StatusNoContent || !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("preflight: status %d, methods %q", rec.Code, rec.Header().Get("Access-Control-Allow-Methods"))
	}
	// Without this the extension cannot send a bearer token at all.
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Errorf("preflight allows headers %q, want Authorization among them", rec.Header().Get("Access-Control-Allow-Headers"))
	}

	if rec := do(t, h, httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Errorf("no origin header: status %d, want 200", rec.Code)
	}
}

func TestEventsBatchDropsMalformedEventsAndKeepsTheRest(t *testing.T) {
	s, fs := newServer(t)
	pv := uuid.Must(uuid.NewV7())
	body := map[string]any{
		"device_id": uuid.Must(uuid.NewV7()),
		"events": []map[string]any{
			{"type": "page_view", "id": pv, "url": "https://Example.com/a?utm_source=x", "title": "A",
				"started_at": "2026-09-08T10:00:00Z", "navigation_type": "load", "referrer": "chrome://newtab"},
			{"type": "page_view", "id": uuid.Must(uuid.NewV7()), "url": "https://example.com/private", "title": "secret",
				"started_at": "2026-09-08T10:00:01Z", "navigation_type": "load", "private": true},
			{"type": "page_view", "id": "not-a-uuid", "url": "https://example.com/", "started_at": "2026-09-08T10:00:00Z", "navigation_type": "load"},
			{"type": "span_start", "id": uuid.Must(uuid.NewV7()), "page_view_id": uuid.Must(uuid.NewV7()), "started_at": "2026-09-08T10:00:00Z"},
			{"type": "span_end", "id": uuid.Must(uuid.NewV7()), "ended_at": "garbage", "reason": "idle"},
			{"type": "teleport", "id": uuid.Must(uuid.NewV7())},
		},
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/v1/events/batch", bytes.NewReader(raw))
	rec := do(t, s.Handler(), req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var res struct{ Accepted, Dropped int }
	decode(t, rec, &res)
	if res.Accepted != 2 || res.Dropped != 4 {
		t.Errorf("accepted=%d dropped=%d, want 2 and 4", res.Accepted, res.Dropped)
	}
	if len(fs.events.PageViews) != 2 || fs.events.PageViews[0].URL.Normalized != "https://example.com/a" || fs.events.PageViews[0].Referrer != nil {
		t.Errorf("page views passed to the store: %+v", fs.events.PageViews)
	}
	if private := fs.events.PageViews[1]; !private.Private || private.Title != "" {
		t.Errorf("private page view kept its title: %+v", private)
	}
}

func captureRequest(t *testing.T, meta map[string]any, html []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	metaPart, _ := mw.CreateFormField("meta")
	if err := json.NewEncoder(metaPart).Encode(meta); err != nil {
		t.Fatal(err)
	}
	htmlPart, _ := mw.CreateFormFile("html", "page.html")
	htmlPart.Write(html)
	mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/v1/captures", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func validMeta() map[string]any {
	return map[string]any{
		"capture_id": uuid.Must(uuid.NewV7()), "page_view_id": uuid.Must(uuid.NewV7()), "device_id": uuid.Must(uuid.NewV7()),
		"captured_at": time.Now().UTC().Format(time.RFC3339), "url": "https://example.com/page", "title": "Page",
		"extractor": fake.Name, "reason": "initial", "raw_char_count": 42,
	}
}

func TestCaptureValidation(t *testing.T) {
	s, fs := newServer(t)
	h := s.Handler()
	html := []byte("<html><head><title>Page</title></head><body>hi</body></html>")

	if rec := do(t, h, captureRequest(t, validMeta(), bytes.Repeat([]byte("x"), fakeMaxBytes+1))); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("over max_bytes: status %d, want 413", rec.Code)
	}
	unknown := validMeta()
	unknown["extractor"] = "nope"
	if rec := do(t, h, captureRequest(t, unknown, html)); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown extractor: status %d, want 400", rec.Code)
	}
	badReason := validMeta()
	badReason["reason"] = "because"
	if rec := do(t, h, captureRequest(t, badReason, html)); rec.Code != http.StatusBadRequest {
		t.Errorf("bad reason: status %d, want 400", rec.Code)
	}
	if len(fs.captures) != 0 {
		t.Fatalf("%d captures reached the store from rejected requests", len(fs.captures))
	}

	fs.dedup = true
	rec := do(t, h, captureRequest(t, validMeta(), html))
	if rec.Code != http.StatusCreated {
		t.Fatalf("valid capture: status %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		CaptureID    uuid.UUID `json:"capture_id"`
		RawHash      string    `json:"raw_hash"`
		Deduplicated bool      `json:"deduplicated"`
	}
	decode(t, rec, &res)
	want := blob.Hash(html)
	if !res.Deduplicated || res.RawHash != hex.EncodeToString(want[:]) || len(fs.captures) != 1 || fs.captures[0].Version != 1 {
		t.Errorf("response %+v, captures %d", res, len(fs.captures))
	}
	if got, err := blob.Decompress(fs.captures[0].Blob.Payload); err != nil || !bytes.Equal(got, html) {
		t.Errorf("stored payload does not decompress to the html (%v)", err)
	}
}

func TestSearchNeedsAQuery(t *testing.T) {
	s, _ := newServer(t)
	if rec := do(t, s.Handler(), httptest.NewRequest(http.MethodGet, "/v1/search", nil)); rec.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", rec.Code)
	}
	if rec := do(t, s.Handler(), httptest.NewRequest(http.MethodGet, "/v1/search?q=bun&limit=0", nil)); rec.Code != http.StatusBadRequest {
		t.Errorf("limit 0: status %d, want 400", rec.Code)
	}
}

func TestProtectedRoutesNeedAToken(t *testing.T) {
	const audience = "tracker"
	iss := authtest.NewIssuer(t)
	a, err := auth.New(context.Background(), auth.Config{Issuer: iss.URL, Audience: audience})
	if err != nil {
		t.Fatal(err)
	}
	h := New(&fakeStore{}, metrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)), func() {}, a).Handler()

	// The extension reads healthz to tell a server that is down from one it
	// is not signed in to, so it stays open even with auth on.
	if rec := do(t, h, httptest.NewRequest(http.MethodGet, "/healthz", nil)); rec.Code != http.StatusOK {
		t.Errorf("healthz: status %d, want 200", rec.Code)
	}
	if rec := do(t, h, httptest.NewRequest(http.MethodGet, "/v1/capture-rules", nil)); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status %d, want 401", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/capture-rules", nil)
	req.Header.Set("Authorization", "Bearer "+iss.Token(t, audience))
	if rec := do(t, h, req); rec.Code != http.StatusOK {
		t.Errorf("valid token: status %d, want 200", rec.Code)
	}

	// A preflight carries no Authorization header. Answering it with 401
	// would fail every extension request before the real one is ever sent.
	preflight := httptest.NewRequest(http.MethodOptions, "/v1/captures", nil)
	preflight.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	preflight.Header.Set("Access-Control-Request-Method", "POST")
	if rec := do(t, h, preflight); rec.Code != http.StatusNoContent {
		t.Errorf("preflight with auth on: status %d, want 204", rec.Code)
	}
}
