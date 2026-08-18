package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

const testDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// attachmentServer seeds one message with one attachment and returns a server
// wired to a real database — these routes read and write rows the fake reader
// does not model.
func attachmentServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := storetest.New(t)
	dir := t.TempDir()
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	id, err := st.InsertMessage(ctx, store.Message{
		Source: "proton", ExternalID: "m1", Sender: "alice@example.com",
		Subject: "invoice", Body: "attached", SentAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAttachment(ctx, store.Attachment{
		MessageID: id, Filename: "scan.pdf", MimeType: "application/pdf",
		SizeBytes: 2048, SHA256: testDigest,
	}); err != nil {
		t.Fatal(err)
	}
	return &Server{db: st, read: st, blobs: blobs, dataDir: dir, archiveDir: filepath.Join(dir, "archive")}, st
}

func do(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	// The mux is exercised rather than the handler directly, so a route that
	// is registered wrong fails here instead of in production.
	handlerFor(s).ServeHTTP(w, r)
	return w
}

// handlerFor is Handler without the token middleware, which has its own tests.
func handlerFor(s *Server) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/attachments", s.handleAttachmentList)
	mux.HandleFunc("GET /v1/attachments/stats", s.handleAttachmentStats)
	mux.HandleFunc("POST /v1/attachments/refresh", s.handleAttachmentRefresh)
	mux.HandleFunc("GET /v1/attachments/{sha256}/text", s.handleAttachmentTextGet)
	mux.HandleFunc("PUT /v1/attachments/{sha256}/text", s.handleAttachmentTextPut)
	mux.HandleFunc("DELETE /v1/attachments/{sha256}/text", s.handleAttachmentTextDelete)
	return mux
}

// The whole point of the write route: a model running on a laptop lists the
// work, posts text back, and the archive becomes searchable inside that file.
func TestAttachmentTextRoundTripOverHTTP(t *testing.T) {
	s, st := attachmentServer(t)

	w := do(t, s, http.MethodGet, "/v1/attachments?status=pending", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	var listed []store.BlobRef
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].SHA256 != testDigest || listed[0].Status != store.StatusPending {
		t.Fatalf("listed = %+v", listed)
	}

	if w = do(t, s, http.MethodPut, "/v1/attachments/"+testDigest+"/text", "chatsworth deed of sale"); w.Code != http.StatusOK {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}
	if w = do(t, s, http.MethodPost, "/v1/attachments/refresh", ""); w.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", w.Code, w.Body)
	}

	msgs, err := st.Search(context.Background(), "chatsworth", store.SearchOpts{Fuzzy: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("found %d messages by text posted over HTTP, want 1", len(msgs))
	}

	w = do(t, s, http.MethodGet, "/v1/attachments/"+testDigest+"/text", "")
	var bt store.BlobText
	if err := json.Unmarshal(w.Body.Bytes(), &bt); err != nil {
		t.Fatal(err)
	}
	// Text arriving without a stated status is someone's own transcription,
	// and automatic passes must not overwrite it.
	if bt.Status != "manual" {
		t.Fatalf("status = %q, want manual", bt.Status)
	}

	if w = do(t, s, http.MethodDelete, "/v1/attachments/"+testDigest+"/text", ""); w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if w = do(t, s, http.MethodGet, "/v1/attachments/"+testDigest+"/text", ""); w.Code != http.StatusNotFound {
		t.Fatalf("get after delete: %d, want 404", w.Code)
	}
}

// A run against a remote archive reports its real outcome, so needs_ocr posted
// from a laptop stays needs_ocr rather than becoming a manual transcription.
func TestAttachmentTextKeepsAStatedStatus(t *testing.T) {
	s, _ := attachmentServer(t)
	if w := do(t, s, http.MethodPut, "/v1/attachments/"+testDigest+"/text?status=needs_ocr&extractor=pdf", ""); w.Code != http.StatusOK {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}
	w := do(t, s, http.MethodGet, "/v1/attachments/"+testDigest+"/text", "")
	var bt store.BlobText
	if err := json.Unmarshal(w.Body.Bytes(), &bt); err != nil {
		t.Fatal(err)
	}
	if bt.Status != "needs_ocr" || bt.Extractor != "pdf" {
		t.Fatalf("got %+v", bt)
	}
}

// A status the archive does not know strands the row: no default pass ever
// selects it again, and the content reads as done when nothing read it.
func TestAttachmentTextRejectsAnInvalidStatus(t *testing.T) {
	s, _ := attachmentServer(t)
	// "pending" spells the same mistake correctly: it means the absence of a
	// row, so a row saying it is a contradiction.
	for _, status := range []string{"needsocr", "done", "pending"} {
		w := do(t, s, http.MethodPut, "/v1/attachments/"+testDigest+"/text?status="+status, "text")
		if w.Code != http.StatusBadRequest {
			t.Errorf("put ?status=%s: %d, want 400", status, w.Code)
		}
	}
	if w := do(t, s, http.MethodGet, "/v1/attachments/"+testDigest+"/text", ""); w.Code != http.StatusNotFound {
		t.Fatalf("a rejected status stored a row anyway: %d", w.Code)
	}
}

// Storing more than a row keeps would halve a transcription silently, and a
// transcription is the one kind of text nothing here can produce again.
func TestAttachmentTextRejectsOversizedBody(t *testing.T) {
	s, _ := attachmentServer(t)
	body := strings.Repeat("a", store.MaxAttachmentTextChars+1)
	if w := do(t, s, http.MethodPut, "/v1/attachments/"+testDigest+"/text", body); w.Code != http.StatusBadRequest {
		t.Fatalf("put oversized text: %d, want 400", w.Code)
	}
}

func TestAttachmentTextRejectsUnknownDigest(t *testing.T) {
	s, _ := attachmentServer(t)
	unknown := strings.Repeat("c", 64)
	// Text for content no message carries would be unreachable by any search
	// and invisible to every refresh: better a 404 than a silent no-op.
	if w := do(t, s, http.MethodPut, "/v1/attachments/"+unknown+"/text", "orphan"); w.Code != http.StatusNotFound {
		t.Fatalf("put unknown digest: %d, want 404", w.Code)
	}
	if w := do(t, s, http.MethodPut, "/v1/attachments/not-a-digest/text", "x"); w.Code != http.StatusBadRequest {
		t.Fatalf("put bad digest: %d, want 400", w.Code)
	}
	if w := do(t, s, http.MethodGet, "/v1/attachments/not-a-digest/text", ""); w.Code != http.StatusBadRequest {
		t.Fatalf("get bad digest: %d, want 400", w.Code)
	}
}

func TestAttachmentStatsOverHTTP(t *testing.T) {
	s, _ := attachmentServer(t)
	w := do(t, s, http.MethodGet, "/v1/attachments/stats", "")
	if w.Code != http.StatusOK {
		t.Fatalf("stats: %d %s", w.Code, w.Body)
	}
	var stats []store.ExtractionStat
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if len(stats) != 1 || stats[0].Status != store.StatusPending || stats[0].Blobs != 1 {
		t.Fatalf("stats = %+v", stats)
	}
}
