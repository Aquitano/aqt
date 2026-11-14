package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
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

func (f *fakeReader) GetMessageByRef(_ context.Context, cited ref.Message) (store.Message, []store.Attachment, error) {
	if f.messageErr != nil {
		return store.Message{}, nil, f.messageErr
	}
	return store.Message{ID: 7, Ref: cited.String()}, nil, nil
}

func (f *fakeReader) GetThreadPage(_ context.Context, _, _ string, _ store.ThreadOpts) (store.Thread, error) {
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

func (f *fakeReader) ContactMessages(_ context.Context, name string, _ store.ContactMessagesOpts) ([]store.MessageDetail, error) {
	if _, err := f.GetContact(context.Background(), name); err != nil {
		return nil, err
	}
	out := make([]store.MessageDetail, len(f.msgs))
	for i, m := range f.msgs {
		out[i] = store.MessageDetail{Message: m}
	}
	return out, f.contactErr
}

func (f *fakeReader) SuggestIdentities(context.Context, int) ([]store.IdentitySuggestion, error) {
	return []store.IdentitySuggestion{}, f.contactErr
}

func (f *fakeReader) Query(_ context.Context, sql string, limit int) (store.QueryResult, error) {
	f.querySQL, f.queryLimit = sql, limit
	return f.queryRes, f.queryErr
}

func (f *fakeReader) SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error) {
	return library.SearchResult{}, nil
}

func (f *fakeReader) AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error) {
	return nil, nil
}

// noDisks is a file catalogue with nothing in it.
type noDisks struct{}

func (noDisks) Register(huma.API) {}

func (noDisks) Close() error { return nil }

func (noDisks) Content(context.Context, ref.Content) (view.Content, error) {
	return view.Content{}, atticstore.ErrNotFound
}

func (noDisks) Places(context.Context, []content.Digest) (map[content.Digest][]view.Place, error) {
	return nil, nil
}

func (noDisks) SearchDisks(context.Context, atticstore.SearchOptions) (view.SearchResult, error) {
	return view.SearchResult{}, nil
}

func (noDisks) ModifiedFiles(context.Context, time.Time, time.Time, int) ([]view.Place, error) {
	return nil, nil
}

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	token, err := Tokens(dir).New("test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return &Server{
		read:      &fakeReader{msgs: []store.Message{{ID: 7, Ref: "msg:0123456789abcdef", Source: "whatsapp", Body: "hi", SentAt: time.Unix(0, 0)}}},
		blobs:     blobs,
		kinds:     sources.All,
		dataDir:   dir,
		catalogue: noDisks{},
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
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("missing sql: status %d, want 422", resp.StatusCode)
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
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("bad SQL: status %d, want 422", resp.StatusCode)
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
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("healthz without database: status %d, want 503", resp.StatusCode)
	}
	resp.Body.Close()

	resp = get("/v1/search?q=hi", token)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("with token: status %d, want 200", resp.StatusCode)
	}
	var found catalog.Result
	if err := json.NewDecoder(resp.Body).Decode(&found); err != nil {
		t.Fatal(err)
	}
	if len(found.Messages) != 1 || found.Messages[0].Ref != "msg:0123456789abcdef" {
		t.Fatalf("unexpected search payload %+v", found)
	}
	if o := s.read.(*fakeReader).opts; o.Fuzzy != 1 || o.Limit != page.DefaultLimit {
		t.Fatalf("defaults not applied: %+v", o)
	}
}

func TestBlobHandlerValidatesDigest(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	digest, _, err := s.blobs.Put(t.Context(), strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	sum := digest.String()

	cases := []struct {
		name, path string
		want       int
	}{
		// Escaped so the path stays one segment and reaches the handler intact.
		{"traversal", "/v1/blobs/%2e%2e%2f%2e%2e%2fetc%2fpasswd", http.StatusUnprocessableEntity},
		{"uppercase", "/v1/blobs/" + strings.ToUpper(sum), http.StatusUnprocessableEntity},
		{"too short", "/v1/blobs/abc123", http.StatusUnprocessableEntity},
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
				body, _ := os.ReadFile(s.blobs.Path(digest))
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
			if status, body := authedGet(t, srv, token, "/v1/messages/msg:0123456789abcdef"); status != tc.want {
				t.Fatalf("status %d, want %d (%s)", status, tc.want, body)
			}
		})
	}
	// Only a message ref names a message: a row number, a bare value or
	// another kind of ref is refused before it reaches the store.
	for _, cited := range []string{"7", "0123456789abcdef", "content:0123456789abcdef", "item:0123456789abcdef0123456789abcdef"} {
		t.Run("rejects "+cited, func(t *testing.T) {
			s, token := testServer(t)
			srv := httptest.NewServer(s.Handler())
			defer srv.Close()
			if status, body := authedGet(t, srv, token, "/v1/messages/"+cited); status != http.StatusUnprocessableEntity {
				t.Fatalf("status %d, want 422 (%s)", status, body)
			}
		})
	}
	t.Run("message JSON has no row number", func(t *testing.T) {
		s, token := testServer(t)
		srv := httptest.NewServer(s.Handler())
		defer srv.Close()
		_, body := authedGet(t, srv, token, "/v1/messages/msg:0123456789abcdef")
		var fields map[string]any
		if err := json.Unmarshal([]byte(body), &fields); err != nil {
			t.Fatal(err)
		}
		if _, ok := fields["id"]; ok || fields["ref"] != "msg:0123456789abcdef" {
			t.Fatalf("message JSON = %s", body)
		}
	})
}

func TestThreadStatusCodes(t *testing.T) {
	t.Run("found", func(t *testing.T) {
		s, token := testServer(t)
		s.read.(*fakeReader).thread = store.Thread{ThreadID: "t1", Source: "whatsapp", Messages: []store.MessageDetail{{Message: store.Message{ID: 1}}}}
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
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("status %d, want 422 (%s)", status, body)
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
		if status, body := authedGet(t, srv, token, path); status != http.StatusUnprocessableEntity {
			t.Errorf("%s: status %d, want 422 (%s)", path, status, body)
		}
	}
	if status, body := authedGet(t, srv, token, "/v1/search?q=hi&offset=10001"); status != http.StatusUnprocessableEntity {
		t.Errorf("offset past the maximum: status %d (%s)", status, body)
	}
	if status, _ := authedGet(t, srv, token, "/v1/search?q=hi&limit=500&offset=10000&fuzzy=2"); status != http.StatusOK {
		t.Errorf("boundary values rejected: %d", status)
	}
}

func TestEmptyListsSerializeAsArrays(t *testing.T) {
	s, token := testServer(t)
	s.read.(*fakeReader).msgs = []store.Message{}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	for _, path := range []string{"/v1/stats", "/v1/contacts/suggest"} {
		status, body := authedGet(t, srv, token, path)
		if status != http.StatusOK {
			t.Fatalf("%s: status %d", path, status)
		}
		if strings.TrimSpace(body) != "[]" {
			t.Errorf("%s returned %q, want []", path, strings.TrimSpace(body))
		}
	}
}

// importForm is a multipart import body: the options field, then the file.
func importForm(t *testing.T, options, name, body string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	if err := form.WriteField("options", options); err != nil {
		t.Fatal(err)
	}
	part, err := form.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(part, body); err != nil {
		t.Fatal(err)
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, form.FormDataContentType()
}

// A source names rows, never a path: the options are refused before any
// byte is stored, and stored bytes go to the content-addressed blob store.
func TestImportRejectsUnsafeSource(t *testing.T) {
	s, token := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	body, contentType := importForm(t, `{"source": "../../escape"}`, "../../escape.json", "[]")
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/import/json", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status %d, want 422", resp.StatusCode)
	}
	err = filepath.WalkDir(filepath.Dir(s.dataDir), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		stored := !d.IsDir() && strings.HasPrefix(path, filepath.Join(s.dataDir, "blobs"))
		if stored || strings.Contains(d.Name(), "escape") {
			t.Errorf("a refused import wrote %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestImportFailureSeparatesInputFromInfrastructure(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want int
	}{
		{errors.New("no chat .txt inside zip"), http.StatusUnprocessableEntity},
		{fail.Opf("insert message: %w", errors.New("connection refused")), http.StatusInternalServerError},
		{fmt.Errorf("wrapped: %w", fail.Op(errors.New("disk full"))), http.StatusInternalServerError},
		{context.Canceled, http.StatusInternalServerError},
	} {
		var failed *httpapi.Error
		if !errors.As(importFailure(tc.err), &failed) || failed.GetStatus() != tc.want {
			t.Errorf("%v: %v, want status %d", tc.err, failed, tc.want)
		}
	}
}

func (f *fakeReader) ListMailboxes(context.Context, string) ([]store.Mailbox, error) {
	return []store.Mailbox{}, nil
}

func (f *fakeReader) MailConflictMessages(context.Context, string, string, ref.Message, int) (store.Thread, error) {
	return store.Thread{}, nil
}

func (f *fakeReader) BrowseThreads(context.Context, store.BrowseOpts) ([]store.ThreadGroup, error) {
	return []store.ThreadGroup{}, nil
}

func TestReadTokensReadAndOnlyWriteTokensWrite(t *testing.T) {
	s, writer := testServer(t)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	reader, err := Tokens(s.dataDir).New("reader", tokens.Read)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, token, method, path, body string
		want                            int
	}{
		{"a read token reads", reader, http.MethodGet, "/v1/search?q=hi", "", http.StatusOK},
		{"a read token runs read-only SQL", reader, http.MethodPost, "/v1/query", `{"sql": "select 1"}`, http.StatusOK},
		// The handler refuses the empty ID, which shows the token was let through.
		{"a read token looks items up by POST", reader, http.MethodPost, "/v1/library/items/summaries", `{"ids": [""]}`, http.StatusUnprocessableEntity},
		{"a read token cannot write", reader, http.MethodPost, "/v1/attachments/refresh", "", http.StatusForbidden},
		{"a read token cannot import", reader, http.MethodPost, "/v1/import/json", "[]", http.StatusForbidden},
		{"a read token cannot record coverage", reader, http.MethodPut, "/v1/sources/gmail/coverage", `{"text": "x"}`, http.StatusForbidden},
		{"a write token may write", writer, http.MethodPut, "/v1/sources/gmail/coverage", `{"text": 5}`, http.StatusUnprocessableEntity},
	} {
		req, err := http.NewRequestWithContext(t.Context(), tc.method, srv.URL+tc.path, strings.NewReader(tc.body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+tc.token)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
	}
}

func TestUnreadableTokenFileIsTheServersFault(t *testing.T) {
	s, token := testServer(t)
	if err := os.Remove(Tokens(s.dataDir).Path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(Tokens(s.dataDir).Path, 0o700); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	if status, body := authedGet(t, srv, token, "/v1/stats"); status != http.StatusInternalServerError || !strings.Contains(body, `"Internal"`) {
		t.Fatalf("status %d, want 500 (%s)", status, body)
	}
}
