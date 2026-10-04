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
)

func TestLibraryRoutesValidateFiltersAndKeepPreviewInert(t *testing.T) {
	s, st := attachmentServer(t)
	token, err := NewToken(s.dataDir, "test")
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
	for _, path := range []string{"/v1/attachment-library?type=pdf", "/v1/attachments/" + testDigest + "/messages", "/v1/import-reports"} {
		if w := request(path); w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	if err := st.PutBlobText(context.Background(), store.BlobText{SHA256: testDigest, Text: "Payment due tomorrow", Status: "ok"}); err != nil {
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
	for _, path := range []string{"/v1/attachment-library?since=invalid", "/v1/attachment-library?offset=-1", "/v1/attachment-library?person=absent", "/v1/import-reports?before=-1", "/v1/attachments/invalid/messages"} {
		if w := request(path); w.Code != 400 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
	id, err := st.FindMessageID(context.Background(), "proton", "m1")
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{"<html><script>alert(1)</script></html>", "%PDF-1.4\npreview"} {
		sum, size, err := s.blobs.Put(strings.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if err := st.InsertAttachment(context.Background(), store.Attachment{MessageID: id, Filename: "untrusted.pdf", MimeType: "application/pdf", SHA256: sum, SizeBytes: size}); err != nil {
			t.Fatal(err)
		}
		w := request("/v1/attachments/" + sum + "/preview")
		if strings.HasPrefix(content, "<html>") {
			if w.Code != 415 {
				t.Fatalf("active content preview: %d", w.Code)
			}
		} else if w.Code != 200 || w.Header().Get("Content-Type") != "application/pdf" || w.Header().Get("Content-Security-Policy") != "default-src 'none'; frame-ancestors 'self'" {
			t.Fatalf("PDF preview: %d %+v", w.Code, w.Header())
		}
	}
}

func TestLibraryPreviewRecognizesAudioBytes(t *testing.T) {
	s, st := attachmentServer(t)
	token, err := NewToken(s.dataDir, "test")
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.FindMessageID(context.Background(), "proton", "m1")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ filename, mime string }{{"soundtrack.flac", "audio/flac"}, {"raw.mp3", "audio/mpeg"}, {"soundtrack.aac", "audio/aac"}} {
		encoded, err := os.ReadFile(filepath.Join("testdata", "preview", test.filename+".base64"))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
		if err != nil {
			t.Fatal(err)
		}
		sum, size, err := s.blobs.Put(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if err = st.InsertAttachment(context.Background(), store.Attachment{MessageID: id, Filename: test.filename, MimeType: "application/octet-stream", SHA256: sum, SizeBytes: size}); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "/v1/attachments/"+sum+"/preview", nil)
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
	input := filepath.Join(t.TempDir(), "viewing.csv")
	if err := os.WriteFile(input, []byte("Title,Date\nA Film,03/04/2024\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ImportMediaFile(ctx, "netflix", "", "dates", input, "dmy"); err != nil {
		t.Fatal(err)
	}
	rows, err := c.ListLibraryActivity(ctx, library.ListOptions{Source: "netflix", Account: "dates"})
	if err != nil || len(rows) != 1 || rows[0].Occurred.Value != "2024-04-03" {
		t.Fatalf("remote day-first date: %+v %v", rows, err)
	}
	s, token := testServer(t)
	for _, path := range []string{"/v1/import/netflix?date_order=ymd", "/v1/import/youtube-media?date_order=dmy"} {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 400 || !strings.Contains(w.Body.String(), "date_order") {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
	}
}
