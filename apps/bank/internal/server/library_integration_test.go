package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

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
