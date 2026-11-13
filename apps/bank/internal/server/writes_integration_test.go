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

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
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
	token, err := Tokens(dir).New("test", tokens.Scope{})
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

	t.Run("contact aliases", func(t *testing.T) {
		if status, body := send(http.MethodPost, "/v1/contacts", `{"name":"dave"}`); status != http.StatusOK {
			t.Fatalf("create: status %d (%s)", status, body)
		}
		status, body := send(http.MethodPost, "/v1/contacts/dave/aliases", `{"source":"","value":"alice@example.com"}`)
		if status != http.StatusConflict || !strings.Contains(body, `"_tag":"AliasTaken"`) || !strings.Contains(body, `\"alice\"`) {
			t.Fatalf("an alias alice has: status %d (%s), want 409 naming her", status, body)
		}
		if status, body := send(http.MethodPost, "/v1/contacts/dave/aliases", `{"source":"","value":"dave@example.com"}`); status != http.StatusOK {
			t.Fatalf("add: status %d (%s)", status, body)
		}
		status, body = send(http.MethodDelete, "/v1/contacts/dave/aliases?source=&value=dave%40example.com", "")
		if status != http.StatusOK || strings.TrimSpace(body) != `{"removed":true}` {
			t.Fatalf("remove: status %d (%s)", status, body)
		}
		status, body = send(http.MethodDelete, "/v1/contacts/dave", "")
		if status != http.StatusOK || strings.TrimSpace(body) != `{"deleted":true}` {
			t.Fatalf("delete: status %d (%s)", status, body)
		}
		if status, body := send(http.MethodDelete, "/v1/contacts/dave", ""); status != http.StatusNotFound {
			t.Fatalf("delete again: status %d, want 404 (%s)", status, body)
		}
	})

	t.Run("contact messages", func(t *testing.T) {
		status, body := authedGet(t, srv, token, "/v1/contacts/alice/messages?limit=100")
		if status != http.StatusOK || !strings.Contains(body, `"external_id":"g1"`) {
			t.Fatalf("status %d (%s), want alice's message", status, body)
		}
		if status, body := authedGet(t, srv, token, "/v1/contacts/alice/messages?before=999999"); status != http.StatusUnprocessableEntity {
			t.Fatalf("a cursor that is not her message: status %d, want 422 (%s)", status, body)
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
