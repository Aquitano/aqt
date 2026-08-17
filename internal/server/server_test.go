package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
)

// fakeReader stands in for the database so handler tests need no Postgres.
type fakeReader struct {
	msgs []store.Message
	opts store.SearchOpts
}

func (f *fakeReader) Search(_ context.Context, _ string, o store.SearchOpts) ([]store.Message, error) {
	f.opts = o
	return f.msgs, nil
}

func (f *fakeReader) GetMessage(context.Context, int64) (store.Message, []store.Attachment, error) {
	return store.Message{}, nil, nil
}

func (f *fakeReader) Stats(context.Context) ([]store.SourceStats, error) { return nil, nil }

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	token, err := NewToken(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return &Server{
		read:       &fakeReader{msgs: []store.Message{{ID: 7, Source: "whatsapp", Body: "hi", SentAt: time.Unix(0, 0)}}},
		blobs:      blobs,
		dataDir:    dir,
		archiveDir: filepath.Join(dir, "archive"),
	}, token
}

func TestSearchRequiresToken(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	get := func(path, token string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp := get("/v1/search?q=hi", "")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token: status %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()

	resp = get("/v1/search?q=hi", token+"nope")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()

	resp = get("/healthz", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: status %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()

	resp = get("/v1/search?q=hi", token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("with token: status %d, want 200", resp.StatusCode)
	}
	var msgs []store.Message
	if err := json.NewDecoder(resp.Body).Decode(&msgs); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].ID != 7 {
		t.Fatalf("unexpected search payload %+v", msgs)
	}
	if o := s.read.(*fakeReader).opts; o.Fuzzy != 1 || o.Limit != 20 {
		t.Fatalf("defaults not applied: %+v", o)
	}
}

func TestBlobHandlerValidatesDigest(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	sum, _, err := s.blobs.Put(strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name, path string
		want       int
	}{
		// Escaped so the path stays one segment and reaches the handler intact.
		{"traversal", "/v1/blobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd", http.StatusBadRequest},
		{"uppercase", "/v1/blobs/" + strings.ToUpper(sum), http.StatusBadRequest},
		{"too short", "/v1/blobs/abc123", http.StatusBadRequest},
		{"absent", "/v1/blobs/" + sum[:63] + "f", http.StatusNotFound},
		{"present", "/v1/blobs/" + sum, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, srv.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Authorization", "Bearer "+token)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("status %d, want %d", resp.StatusCode, tc.want)
			}
			if tc.want == http.StatusOK {
				body, _ := os.ReadFile(s.blobs.Path(sum))
				if string(body) != "payload" {
					t.Fatalf("blob content = %q", body)
				}
			}
		})
	}
}
