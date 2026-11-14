package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestLibraryRoutesValidateFiltersAndKeepPreviewInert(t *testing.T) {
	s, st := attachmentServer(t)
	token, err := Tokens(s.dataDir).New("test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.Handler()
	request := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/v1/attachment-library?type=pdf", "/v1/attachments/" + testDigest.String() + "/messages", "/v1/raw-inputs"} {
		if w := request(path); w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if err := st.PutBlobText(context.Background(), store.BlobText{BLAKE3: testDigest, Text: "Payment due tomorrow", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"payment", "missing"} {
		w := request("/v1/attachment-library?text=" + query)
		var files []store.LibraryFile
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &files) != nil {
			t.Fatalf("text search: %d %s", w.Code, w.Body)
		}
		if query == "payment" && (len(files) != 1 || files[0].Snippet != "Payment due tomorrow") || query == "missing" && len(files) != 0 {
			t.Fatalf("text=%s: %+v", query, files)
		}
	}
	for _, path := range []string{"/v1/attachment-library?since=invalid", "/v1/attachment-library?offset=-1", "/v1/attachment-library?person=absent", "/v1/attachments/invalid/messages"} {
		if w := request(path); w.Code != 422 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if w := request("/v1/raw-inputs?before=-1"); w.Code != 422 {
		t.Fatalf("raw inputs: %d %s", w.Code, w.Body)
	}
	// The web UI sends every filter, set or not.
	if w := request("/v1/attachment-library?q=&text=&type=&person=&since=&until=&match=&offset=0"); w.Code != 200 {
		t.Fatalf("empty filters: %d %s", w.Code, w.Body)
	}
	id, err := st.FindMessageID(context.Background(), "proton", "m1")
	if err != nil {
		t.Fatal(err)
	}
	for i, content := range []string{"<html><script>alert(1)</script></html>", "%PDF-1.4\npreview"} {
		sum, size, err := s.blobs.Put(context.Background(), strings.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if err := st.InsertAttachment(context.Background(), store.Attachment{MessageID: id, Position: i + 1, Filename: "untrusted.pdf", MimeType: "application/pdf", BLAKE3: sum, SizeBytes: size}); err != nil {
			t.Fatal(err)
		}
		w := request("/v1/attachments/" + sum.String() + "/preview")
		if strings.HasPrefix(content, "<html>") {
			if w.Code != 415 {
				t.Fatalf("active content preview: %d", w.Code)
			}
		} else if w.Code != 200 || w.Header().Get("Content-Type") != "application/pdf" || w.Header().Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'self'" {
			t.Fatalf("PDF preview: %d %+v", w.Code, w.Header())
		}
	}
}

func TestLibraryStateRejectsInvalidTextWithoutAdvancingRevision(t *testing.T) {
	s, st := attachmentServer(t)
	item := library.Item{Identity: library.Identity{Source: "manual", ExternalID: "invalid-notes"}, Kind: "movie", Title: "Example"}
	if _, err := st.ImportLibrary(context.Background(), library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	token, err := Tokens(s.dataDir).New("test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.Handler()
	for _, test := range []struct {
		notes string
		code  int
	}{{"bad\x00notes", 422}, {"valid notes", 200}} {
		body, err := json.Marshal(library.StateEdit{Notes: test.notes})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("PUT", "/v1/library/items/"+library.StableID("item", item.Identity)+"/state", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.code {
			t.Fatalf("notes %q: %d %s", test.notes, w.Code, w.Body)
		}
	}
}

func TestLibraryPreviewRecognizesAudioBytes(t *testing.T) {
	s, st := attachmentServer(t)
	token, err := Tokens(s.dataDir).New("test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.FindMessageID(context.Background(), "proton", "m1")
	if err != nil {
		t.Fatal(err)
	}
	for i, test := range []struct{ filename, mime string }{{"soundtrack.flac", "audio/flac"}, {"raw.mp3", "audio/mpeg"}, {"soundtrack.aac", "audio/aac"}} {
		encoded, err := os.ReadFile(filepath.Join("testdata", "preview", test.filename+".base64"))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
		if err != nil {
			t.Fatal(err)
		}
		sum, size, err := s.blobs.Put(context.Background(), bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err = st.InsertAttachment(context.Background(), store.Attachment{MessageID: id, Position: i + 1, Filename: test.filename, MimeType: "application/octet-stream", BLAKE3: sum, SizeBytes: size}); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "/v1/attachments/"+sum.String()+"/preview", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Content-Type") != test.mime || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s: %d %+v %s", test.filename, w.Code, w.Header(), w.Body)
		}
	}
}

func TestLibraryRemoteNetflixDateOrder(t *testing.T) {
	ctx := context.Background()
	c, _ := libraryClient(t)
	if _, err := c.Import(ctx, "netflix", "viewing.csv", strings.NewReader("Title,Date\nA Film,03/04/2024\n"), json.RawMessage(`{"account": "dates", "date_order": "dmy"}`)); err != nil {
		t.Fatal(err)
	}
	rows, err := c.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix", Account: "dates"})
	if err != nil || len(rows) != 1 || rows[0].Occurred.Value != "2024-04-03" {
		t.Fatalf("remote day-first date: %+v %v", rows, err)
	}
	for kind, options := range map[string]string{"netflix": `{"date_order": "ymd"}`, "youtube-media": `{"date_order": "dmy"}`} {
		_, err := c.Import(ctx, kind, "viewing.csv", strings.NewReader("Title,Date\n"), json.RawMessage(options))
		if err == nil || !strings.Contains(err.Error(), "date") {
			t.Fatalf("%s %s: %v, want the date order refused", kind, options, err)
		}
	}
}
