package server

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/extract"
)

var testDigest = content.Sum([]byte("scan.pdf"))

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
		SizeBytes: 2048, BLAKE3: testDigest,
	}); err != nil {
		t.Fatal(err)
	}
	s := New(st, blobs, dir, sources.All)
	return s, st
}

// The whole point of the write route: a model running on a laptop lists the
// work, posts text back, and the archive becomes searchable inside that file.
func TestAttachmentTextRoundTripOverHTTP(t *testing.T) {
	s, st := attachmentServer(t)

	w := authed(t, s, http.MethodGet, "/v1/attachments?status=pending", "")
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body)
	}
	var listed []store.BlobRef
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].BLAKE3 != testDigest || listed[0].Status != store.StatusPending {
		t.Fatalf("listed = %+v", listed)
	}

	if w = authed(t, s, http.MethodPut, "/v1/attachments/"+testDigest.String()+"/text", "chatsworth deed of sale"); w.Code != http.StatusOK {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}

	q, err := search.Parse("chatsworth", search.All)
	if err != nil {
		t.Fatal(err)
	}
	if found, err := st.SearchTexts(context.Background(), q, search.Filters{}, 10); err != nil || len(found.Hits) != 1 {
		t.Fatalf("found %+v, %v by text posted over HTTP, want its content", found.Hits, err)
	}

	w = authed(t, s, http.MethodGet, "/v1/attachments/"+testDigest.String()+"/text", "")
	var bt store.BlobText
	if err := json.Unmarshal(w.Body.Bytes(), &bt); err != nil {
		t.Fatal(err)
	}
	// Text arriving without a stated status is someone's own transcription,
	// and automatic passes must not overwrite it.
	if bt.Status != "manual" {
		t.Fatalf("status = %q, want manual", bt.Status)
	}

	if w = authed(t, s, http.MethodDelete, "/v1/attachments/"+testDigest.String()+"/text", ""); w.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", w.Code, w.Body)
	}
	if w = authed(t, s, http.MethodGet, "/v1/attachments/"+testDigest.String()+"/text", ""); w.Code != http.StatusNotFound {
		t.Fatalf("get after delete: %d, want 404", w.Code)
	}
}

// A run against a remote archive reports its real outcome, so needs_ocr posted
// from a laptop stays needs_ocr rather than becoming a manual transcription.
func TestAttachmentTextKeepsAStatedStatus(t *testing.T) {
	s, _ := attachmentServer(t)
	if w := authed(t, s, http.MethodPut, "/v1/attachments/"+testDigest.String()+"/text?status=needs_ocr&extractor=pdf", ""); w.Code != http.StatusOK {
		t.Fatalf("put: %d %s", w.Code, w.Body)
	}
	w := authed(t, s, http.MethodGet, "/v1/attachments/"+testDigest.String()+"/text", "")
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
func TestAttachmentTextRejectsInvalidWrites(t *testing.T) {
	s, _ := attachmentServer(t)
	path := "/v1/attachments/" + testDigest.String() + "/text"
	// "pending" spells the same mistake correctly: it means the absence of a
	// row, so a row saying it is a contradiction.
	for _, tc := range []struct {
		name, method, path, body string
		status                   int
	}{
		{"unknown status", http.MethodPut, path + "?status=needsocr", "text", http.StatusUnprocessableEntity},
		{"pending is the absence of text", http.MethodPut, path + "?status=pending", "text", http.StatusUnprocessableEntity},
		{"text exceeds storage limit", http.MethodPut, path, strings.Repeat("a", extract.MaxChars+1), http.StatusUnprocessableEntity},
		{"unknown digest", http.MethodPut, "/v1/attachments/" + strings.Repeat("c", 64) + "/text", "orphan", http.StatusNotFound},
		{"malformed write digest", http.MethodPut, "/v1/attachments/not-a-digest/text", "x", http.StatusUnprocessableEntity},
		{"malformed read digest", http.MethodGet, "/v1/attachments/not-a-digest/text", "", http.StatusUnprocessableEntity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := authed(t, s, tc.method, tc.path, tc.body); w.Code != tc.status {
				t.Errorf("status = %d, want %d", w.Code, tc.status)
			}
		})
	}
	if w := authed(t, s, http.MethodGet, path, ""); w.Code != http.StatusNotFound {
		t.Fatalf("a rejected write stored a row: %d", w.Code)
	}
}

func TestAttachmentStatsOverHTTP(t *testing.T) {
	s, _ := attachmentServer(t)
	w := authed(t, s, http.MethodGet, "/v1/attachments/stats", "")
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
