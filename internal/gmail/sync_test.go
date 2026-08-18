package gmail

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

// stubGmail serves the three endpoints the sync uses. Message ids map to a
// status: 200 with a real mail, 404 for one that is gone for good, or 500 for
// one that may yet come back.
type stubGmail struct {
	t         *testing.T
	historyID string
	ids       []string // returned by the full listing
	history   []string // returned by the history delta
	status    map[string]int
	fetched   map[string]int
}

func (g *stubGmail) start(t *testing.T) {
	t.Helper()
	g.fetched = map[string]int{}
	oldBackoff := retryBase
	retryBase = time.Millisecond
	t.Cleanup(func() { retryBase = oldBackoff })
	srv := httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(srv.Close)
	old := apiBase
	apiBase = srv.URL
	t.Cleanup(func() { apiBase = old })
}

func (g *stubGmail) serve(w http.ResponseWriter, r *http.Request) {
	write := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.URL.Path == "/profile":
		write(map[string]string{"emailAddress": "me@example.com", "historyId": g.historyID})
	case r.URL.Path == "/messages":
		ids := make([]map[string]string, 0, len(g.ids))
		for _, id := range g.ids {
			ids = append(ids, map[string]string{"id": id})
		}
		write(map[string]any{"messages": ids})
	case r.URL.Path == "/history":
		added := make([]map[string]any, 0, len(g.history))
		for _, id := range g.history {
			added = append(added, map[string]any{
				"messagesAdded": []map[string]any{{"message": map[string]string{"id": id}}},
			})
		}
		write(map[string]any{"history": added, "historyId": g.historyID})
	case strings.HasPrefix(r.URL.Path, "/messages/"):
		id := strings.TrimPrefix(r.URL.Path, "/messages/")
		g.fetched[id]++
		switch g.status[id] {
		case http.StatusNotFound:
			w.WriteHeader(http.StatusNotFound)
		case http.StatusInternalServerError:
			w.WriteHeader(http.StatusInternalServerError)
		default:
			raw := fmt.Sprintf("From: a@example.com\r\nSubject: mail %s\r\n"+
				"Message-ID: <%s@example.com>\r\nDate: Mon, 13 May 2024 21:08:00 +0200\r\n\r\nbody\r\n", id, id)
			write(map[string]string{
				"id": id, "threadId": "t-" + id, "internalDate": "1715627280000",
				"raw": base64.RawURLEncoding.EncodeToString([]byte(raw)),
			})
		}
	default:
		g.t.Errorf("unexpected request %s", r.URL)
		w.WriteHeader(http.StatusTeapot)
	}
}

func syncFixture(t *testing.T) (*store.Store, *blob.Store, string) {
	t.Helper()
	st := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return st, blobs, filepath.Join(root, "archive")
}

func loadedState(t *testing.T, st *store.Store) syncState {
	t.Helper()
	raw, err := st.GetSyncState(context.Background(), "gmail")
	if err != nil {
		t.Fatal(err)
	}
	var s syncState
	if raw != nil {
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func TestBackfillAdvancesPastAPermanently404Message(t *testing.T) {
	ctx := context.Background()
	st, blobs, archiveDir := syncFixture(t)
	g := &stubGmail{t: t, historyID: "100", ids: []string{"good", "gone"},
		status: map[string]int{"gone": http.StatusNotFound}}
	g.start(t)

	res, err := runSync(ctx, &client{http: http.DefaultClient}, st, blobs, archiveDir, false)
	if err != nil {
		t.Fatalf("a message that no longer exists must not fail the run: %v", err)
	}
	if res.Mode != "backfill" || res.Inserted != 1 {
		t.Fatalf("res = %+v", res)
	}
	if res.Quarantined != 1 || len(res.QuarantinedIDs) != 1 || res.QuarantinedIDs[0] != "gone" {
		t.Fatalf("the dead message was not reported: %+v", res)
	}
	state := loadedState(t, st)
	if state.HistoryID != "100" {
		t.Fatalf("checkpoint = %q, want it advanced", state.HistoryID)
	}
	if _, ok := state.Quarantined["gone"]; !ok {
		t.Fatalf("quarantine = %v", state.Quarantined)
	}

	// The next run must not spend a request on it again.
	g.historyID = "101"
	g.history = []string{"gone"}
	before := g.fetched["gone"]
	res, err = runSync(ctx, &client{http: http.DefaultClient}, st, blobs, archiveDir, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != "incremental" {
		t.Fatalf("mode = %q", res.Mode)
	}
	if g.fetched["gone"] != before {
		t.Errorf("a quarantined message was fetched again")
	}
	if loadedState(t, st).HistoryID != "101" {
		t.Errorf("the incremental checkpoint did not advance")
	}
}

func TestRetryableFailureHoldsTheCheckpoint(t *testing.T) {
	ctx := context.Background()
	st, blobs, archiveDir := syncFixture(t)
	g := &stubGmail{t: t, historyID: "100", ids: []string{"good", "flaky"},
		status: map[string]int{"flaky": http.StatusInternalServerError}}
	g.start(t)

	res, err := runSync(ctx, &client{http: http.DefaultClient}, st, blobs, archiveDir, false)
	if err == nil {
		t.Fatal("a retryable failure should surface")
	}
	if res.Failed != 1 || res.Quarantined != 0 {
		t.Fatalf("a 5xx must stay retryable, not be quarantined: %+v", res)
	}
	if state := loadedState(t, st); state.HistoryID != "" {
		t.Errorf("checkpoint advanced past a message that may still arrive: %q", state.HistoryID)
	}

	// Once the API recovers, the same run completes and the checkpoint moves.
	g.status = map[string]int{}
	res, err = runSync(ctx, &client{http: http.DefaultClient}, st, blobs, archiveDir, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 || res.Duplicates != 1 {
		t.Fatalf("res = %+v, want the retried message inserted and the known one skipped", res)
	}
	if loadedState(t, st).HistoryID != "100" {
		t.Error("checkpoint did not advance after a clean run")
	}
}

func TestQuarantineSurvivesAFailedRun(t *testing.T) {
	ctx := context.Background()
	st, blobs, archiveDir := syncFixture(t)
	g := &stubGmail{t: t, historyID: "100", ids: []string{"gone", "flaky"},
		status: map[string]int{"gone": http.StatusNotFound, "flaky": http.StatusInternalServerError}}
	g.start(t)

	if _, err := runSync(ctx, &client{http: http.DefaultClient}, st, blobs, archiveDir, false); err == nil {
		t.Fatal("the retryable failure should surface")
	}
	state := loadedState(t, st)
	if state.HistoryID != "" {
		t.Error("checkpoint advanced despite a retryable failure")
	}
	if _, ok := state.Quarantined["gone"]; !ok {
		t.Fatal("a dead message learned during a failed run was forgotten, so it will be re-fetched forever")
	}
}
