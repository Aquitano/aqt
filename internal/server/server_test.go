package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
)

// fakeReader stands in for the database so handler tests need no Postgres.
type fakeReader struct {
	msgs       []store.Message
	opts       store.SearchOpts
	thread     store.Thread
	contacts   []store.Contact
	contactErr error
	searchErr  error
	messageErr error
	threadErr  error
	statsErr   error
	queryRes   store.QueryResult
	queryErr   error
	querySQL   string
	queryLimit int
}

func (f *fakeReader) Search(_ context.Context, _ string, o store.SearchOpts) ([]store.Message, error) {
	f.opts = o
	return f.msgs, f.searchErr
}

func (f *fakeReader) GetMessage(context.Context, int64) (store.Message, []store.Attachment, error) {
	if f.messageErr != nil {
		return store.Message{}, nil, f.messageErr
	}
	return store.Message{ID: 7}, nil, nil
}

func (f *fakeReader) GetMessageByRef(_ context.Context, ref string) (store.Message, []store.Attachment, error) {
	if f.messageErr != nil {
		return store.Message{}, nil, f.messageErr
	}
	return store.Message{ID: 7, Ref: ref}, nil, nil
}

func (f *fakeReader) GetThread(_ context.Context, _, _ string, _ int) (store.Thread, error) {
	return f.thread, f.threadErr
}

func (f *fakeReader) Stats(context.Context) ([]store.SourceStats, error) {
	return []store.SourceStats{}, f.statsErr
}

func (f *fakeReader) ListContacts(context.Context) ([]store.Contact, error) {
	return f.contacts, f.contactErr
}

func (f *fakeReader) GetContact(_ context.Context, name string) (store.Contact, error) {
	for _, c := range f.contacts {
		if c.Name == name {
			return c, nil
		}
	}
	if f.contactErr != nil {
		return store.Contact{}, f.contactErr
	}
	return store.Contact{}, store.ErrNotFound
}

func (f *fakeReader) ContactSourceCounts(context.Context, int64) ([]store.ContactSourceCount, error) {
	return []store.ContactSourceCount{}, f.contactErr
}

func (f *fakeReader) ContactMessages(_ context.Context, name string, _ store.ContactMessagesOpts) ([]store.Message, error) {
	if _, err := f.GetContact(context.Background(), name); err != nil {
		return nil, err
	}
	return f.msgs, f.contactErr
}

func (f *fakeReader) SuggestIdentities(context.Context, int) ([]store.IdentitySuggestion, error) {
	return []store.IdentitySuggestion{}, f.contactErr
}

func (f *fakeReader) Query(_ context.Context, sql string, limit int) (store.QueryResult, error) {
	f.querySQL, f.queryLimit = sql, limit
	return f.queryRes, f.queryErr
}

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

func TestQueryHandler(t *testing.T) {
	s, token := testServer(t)
	fake := s.read.(*fakeReader)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	post := func(body string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/query", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp := post(`{"limit": 5}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing sql: status %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	fake.queryRes = store.QueryResult{Columns: []string{"n"}, Rows: [][]any{{int64(3)}}}
	resp = post(`{"sql": "select count(*) as n from messages", "limit": 5}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid query: status %d, want 200", resp.StatusCode)
	}
	var res store.QueryResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(res.Columns) != 1 || res.Columns[0] != "n" || len(res.Rows) != 1 {
		t.Fatalf("unexpected payload %+v", res)
	}
	if fake.queryLimit != 5 || !strings.Contains(fake.querySQL, "count(*)") {
		t.Fatalf("query not passed through: sql=%q limit=%d", fake.querySQL, fake.queryLimit)
	}

	fake.queryErr = &store.BadQueryError{Err: fmt.Errorf(`relation "nope" does not exist`)}
	resp = post(`{"sql": "select * from nope"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad SQL: status %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	fake.queryErr = fmt.Errorf("connection lost")
	resp = post(`{"sql": "select 1"}`)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("store failure: status %d, want 500", resp.StatusCode)
	}
	resp.Body.Close()
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

// authedGet issues a request with a valid token and returns status plus body.
func authedGet(t *testing.T, srv *httptest.Server, token, path string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestMessageStatusDistinguishesMissingFromBroken(t *testing.T) {
	cases := map[string]struct {
		err  error
		want int
	}{
		"present":       {nil, http.StatusOK},
		"missing":       {store.ErrNotFound, http.StatusNotFound},
		"store failure": {errors.New("connection refused"), http.StatusInternalServerError},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, token := testServer(t)
			s.read.(*fakeReader).messageErr = tc.err
			srv := httptest.NewServer(s.Handler())
			defer srv.Close()
			if status, body := authedGet(t, srv, token, "/v1/messages/7"); status != tc.want {
				t.Fatalf("status %d, want %d (%s)", status, tc.want, body)
			}
		})
	}
	t.Run("unparseable id", func(t *testing.T) {
		s, token := testServer(t)
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		if status, body := authedGet(t, srv, token, "/v1/messages/abc"); status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400 (%s)", status, body)
		}
	})
	// A ref is what citations carry, and an all-digit one must not be read as
	// a row id.
	for _, ref := range []string{"c5e63bfc3750", "123456789012"} {
		t.Run("ref "+ref, func(t *testing.T) {
			s, token := testServer(t)
			srv := httptest.NewServer(s.Handler())
			defer srv.Close()
			status, body := authedGet(t, srv, token, "/v1/messages/"+ref)
			if status != http.StatusOK {
				t.Fatalf("status %d, want 200 (%s)", status, body)
			}
			var d store.MessageDetail
			if err := json.Unmarshal([]byte(body), &d); err != nil {
				t.Fatal(err)
			}
			if d.Ref != ref {
				t.Fatalf("ref = %q, want %q — looked up as a row id", d.Ref, ref)
			}
		})
	}
}

func TestThreadStatusCodes(t *testing.T) {
	t.Run("found", func(t *testing.T) {
		s, token := testServer(t)
		s.read.(*fakeReader).thread = store.Thread{ThreadID: "t1", Source: "whatsapp", Messages: []store.Message{{ID: 1}}}
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		status, body := authedGet(t, srv, token, "/v1/threads/t1")
		if status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		var got store.Thread
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatal(err)
		}
		if got.ThreadID != "t1" || len(got.Messages) != 1 {
			t.Fatalf("payload = %+v", got)
		}
	})
	t.Run("missing", func(t *testing.T) {
		s, token := testServer(t)
		s.read.(*fakeReader).threadErr = store.ErrNotFound
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		if status, body := authedGet(t, srv, token, "/v1/threads/nope"); status != http.StatusNotFound {
			t.Fatalf("status %d, want 404 (%s)", status, body)
		}
	})
	t.Run("ambiguous", func(t *testing.T) {
		s, token := testServer(t)
		s.read.(*fakeReader).threadErr = &store.AmbiguousThreadError{ThreadID: "x", Sources: []string{"discord", "whatsapp"}}
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		status, body := authedGet(t, srv, token, "/v1/threads/x")
		if status != http.StatusBadRequest {
			t.Fatalf("status %d, want 400 (%s)", status, body)
		}
		if !strings.Contains(body, "discord") || !strings.Contains(body, "whatsapp") {
			t.Errorf("the error should name the candidate sources: %s", body)
		}
	})
	t.Run("store failure", func(t *testing.T) {
		s, token := testServer(t)
		s.read.(*fakeReader).threadErr = errors.New("connection refused")
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		if status, body := authedGet(t, srv, token, "/v1/threads/x"); status != http.StatusInternalServerError {
			t.Fatalf("status %d, want 500 (%s)", status, body)
		}
	})
}

func TestSearchValidatesBounds(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, path := range []string{
		"/v1/search?q=hi&limit=0",
		"/v1/search?q=hi&limit=-3",
		"/v1/search?q=hi&limit=100000",
		"/v1/search?q=hi&fuzzy=5",
		"/v1/search?q=hi&fuzzy=-1",
	} {
		if status, body := authedGet(t, srv, token, path); status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400 (%s)", path, status, body)
		}
	}
	if status, _ := authedGet(t, srv, token, "/v1/search?q=hi&limit=500&fuzzy=2"); status != http.StatusOK {
		t.Errorf("boundary values rejected: %d", status)
	}
}

func TestEmptyListsSerializeAsArrays(t *testing.T) {
	s, token := testServer(t)
	s.read.(*fakeReader).msgs = []store.Message{}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, path := range []string{"/v1/search?q=nothing", "/v1/stats"} {
		status, body := authedGet(t, srv, token, path)
		if status != http.StatusOK {
			t.Fatalf("%s: status %d", path, status)
		}
		if strings.TrimSpace(body) != "[]" {
			t.Errorf("%s returned %q, want []", path, strings.TrimSpace(body))
		}
	}
}

func TestImportRejectsUnsafeSource(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/import/json?source=../../escape", strings.NewReader("[]"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	// The traversal must not have created anything next to the archive root.
	if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(s.archiveDir)), "escape")); err == nil {
		t.Fatal("a sibling directory was created")
	}
}

func TestWriteCauseSeparatesInputFromInfrastructure(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want int
	}{
		{errors.New("no chat .txt inside zip"), http.StatusBadRequest},
		{fail.Opf("insert message: %w", errors.New("connection refused")), http.StatusInternalServerError},
		{fmt.Errorf("wrapped: %w", fail.Op(errors.New("disk full"))), http.StatusInternalServerError},
		{context.Canceled, http.StatusInternalServerError},
	} {
		rec := httptest.NewRecorder()
		writeCause(rec, tc.err)
		if rec.Code != tc.want {
			t.Errorf("%v: status %d, want %d", tc.err, rec.Code, tc.want)
		}
	}
}

func TestPruneUploadsKeepsActiveStaging(t *testing.T) {
	dir := t.TempDir()
	staging := uploadStagingDir(dir)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	mk := func(name string, age time.Duration) string {
		p := filepath.Join(staging, name)
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "payload"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := mk("upload-old", 48*time.Hour)
	fresh := mk("upload-new", time.Minute)
	other := mk("not-an-upload", 48*time.Hour)

	if err := pruneUploads(dir, uploadMaxAge); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("an abandoned staging dir survived")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("an upload in flight was pruned")
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("an unrelated directory was removed")
	}
	// A missing staging directory is the normal case on a fresh install.
	if err := pruneUploads(t.TempDir(), uploadMaxAge); err != nil {
		t.Errorf("no staging dir should not be an error: %v", err)
	}
}
