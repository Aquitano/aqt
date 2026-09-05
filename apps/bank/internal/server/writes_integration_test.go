package server

import (
	"context"
	"encoding/json"
	"io"
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

// The write routes run against the real store: the CLI reaches them only over
// HTTP when BANK_URL is set, so the wiring is the part worth exercising.
func TestContactImportAndCoverageRoutes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	token, err := NewToken(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{db: st, read: st, blobs: blobs, dataDir: dir, archiveDir: filepath.Join(dir, "archive")}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()

	if _, err := st.InsertMessage(ctx, store.Message{
		Source: "gmail", ExternalID: "g1", Sender: "alice@example.com", Body: "hi",
		SentAt: time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC),
	}); err != nil {
		t.Fatal(err)
	}

	send := func(method, path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		out, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, string(out)
	}

	t.Run("contact import", func(t *testing.T) {
		status, body := send(http.MethodPost, "/v1/contacts/import",
			`[{"name":"alice","note":"the tenant","aliases":[{"value":"alice@example.com"}]},
			  {"name":"carol","aliases":[{"value":"alice@example.com"},{"source":"gmail","value":"carol@example.com"}]}]`)
		if status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		var res []store.ContactImportResult
		if err := json.Unmarshal([]byte(body), &res); err != nil {
			t.Fatal(err)
		}
		if len(res) != 2 || !res[0].Created || res[0].Aliases != 1 {
			t.Fatalf("results = %+v", res)
		}
		// Carol's first alias belongs to Alice: reported, and the second still lands.
		if res[1].Aliases != 1 || len(res[1].Errors) != 1 {
			t.Fatalf("carol = %+v, want one alias attached and one conflict reported", res[1])
		}
		if _, body := authedGet(t, srv, token, "/v1/contacts/alice"); !strings.Contains(body, "alice@example.com") {
			t.Errorf("the imported contact is not readable back: %s", body)
		}
	})

	t.Run("coverage", func(t *testing.T) {
		if status, body := send(http.MethodPut, "/v1/sources/gmail/coverage",
			`{"text":"everything from 2011 on"}`); status != http.StatusOK {
			t.Fatalf("status %d (%s)", status, body)
		}
		_, body := authedGet(t, srv, token, "/v1/stats")
		var stats []store.SourceStats
		if err := json.Unmarshal([]byte(body), &stats); err != nil {
			t.Fatal(err)
		}
		if len(stats) != 1 || stats[0].Coverage != "everything from 2011 on" {
			t.Fatalf("stats = %+v", stats)
		}
		if stats[0].LastSync != nil {
			t.Error("a coverage note must not read as a sync checkpoint")
		}
	})
}
