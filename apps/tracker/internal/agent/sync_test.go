package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type ingest struct {
	mu      sync.Mutex
	status  int
	batches []int
	auth    string
}

func (i *ingest) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var batch struct {
		DeviceID uuid.UUID         `json:"device_id"`
		Events   []json.RawMessage `json:"events"`
	}
	if r.URL.Path != "/v1/events/batch" || json.NewDecoder(r.Body).Decode(&batch) != nil || batch.DeviceID == uuid.Nil {
		http.Error(w, "malformed", http.StatusTeapot)
		return
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	i.batches = append(i.batches, len(batch.Events))
	i.auth = r.Header.Get("Authorization")
	if i.status != 0 {
		w.WriteHeader(i.status)
		return
	}
	json.NewEncoder(w).Encode(map[string]int{"accepted": len(batch.Events), "dropped": 0})
}

func (i *ingest) fail(status int) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.status = status
}

func (i *ingest) received() []int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return append([]int(nil), i.batches...)
}

func newSyncer(t *testing.T, server *httptest.Server, tokenPath string) *Syncer {
	t.Helper()
	outbox, _, err := OpenOutbox(filepath.Join(t.TempDir(), "device.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSyncer(Config{ServerURL: server.URL, TokenPath: tokenPath}, uuid.Must(uuid.NewV7()),
		outbox, slog.New(slog.DiscardHandler), func() {})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSyncSendsBatchesOfAtMostAThousandWithTheSessionsToken(t *testing.T) {
	server := &ingest{}
	srv := httptest.NewServer(server)
	defer srv.Close()
	tokenPath := filepath.Join(t.TempDir(), "token.json")
	session := `{"token":{"access_token":"secret","token_type":"Bearer","expiry":"2999-01-01T00:00:00Z"}}`
	if err := os.WriteFile(tokenPath, []byte(session), 0o600); err != nil {
		t.Fatal(err)
	}
	s := newSyncer(t, srv, tokenPath)
	s.Enqueue(heartbeats(1500))

	s.Flush(context.Background())

	if got := server.received(); len(got) != 2 || got[0] != 1000 || got[1] != 500 {
		t.Fatalf("batches %v, want 1000 then 500", got)
	}
	if server.auth != "Bearer secret" {
		t.Errorf("Authorization %q, want the stored access token", server.auth)
	}
	if st := s.Status(); st.Pending != 0 || !st.Reachable || st.Error != "" {
		t.Errorf("status %+v, want everything delivered", st)
	}
}

func TestSyncBacksOffWhileTheServerFails(t *testing.T) {
	server := &ingest{status: http.StatusServiceUnavailable}
	srv := httptest.NewServer(server)
	defer srv.Close()
	s := newSyncer(t, srv, "")
	now := t0
	s.now = func() time.Time { return now }
	s.Enqueue(heartbeats(3))
	ctx := context.Background()

	s.flushIfDue(ctx)
	s.flushIfDue(ctx)
	now = now.Add(time.Second)
	s.flushIfDue(ctx)
	if got := server.received(); len(got) != 1 {
		t.Fatalf("%d attempts within the first 2 s of backoff, want 1", len(got))
	}
	if st := s.Status(); st.Pending != 3 || st.Reachable || st.Error != "HTTP 503" {
		t.Errorf("status %+v, want three pending and the server unreachable", st)
	}

	server.fail(0)
	now = now.Add(time.Second)
	s.flushIfDue(ctx)
	if got := server.received(); len(got) != 2 || s.Status().Pending != 0 {
		t.Errorf("attempts %v, pending %d: the retry after the backoff did not deliver", got, s.Status().Pending)
	}
	if backoff(30) != maxBackoff {
		t.Errorf("backoff after 30 failures is %v, want the %v cap", backoff(30), maxBackoff)
	}
}

func TestSyncDropsABatchTheServerWillNeverAccept(t *testing.T) {
	server := &ingest{status: http.StatusBadRequest}
	srv := httptest.NewServer(server)
	defer srv.Close()
	s := newSyncer(t, srv, "")
	s.Enqueue(heartbeats(3))

	s.Flush(context.Background())

	if st := s.Status(); st.Pending != 0 || st.Dropped != 3 || st.Error != "HTTP 400" {
		t.Errorf("status %+v, want the batch dropped and the error kept", st)
	}
}
