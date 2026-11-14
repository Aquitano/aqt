package scan

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// newCatalogue gives a test a catalogue of its own and its database.
type newCatalogue func(*testing.T) (*store.Store, string)

// eachTransport runs a test twice: scanning into the database from this
// process, and through bank serve's API as a scan on another machine does.
func eachTransport(t *testing.T, test func(*testing.T, newCatalogue)) {
	t.Run("local", func(t *testing.T) { test(t, storetest.NewNamed) })
	t.Run("http", func(t *testing.T) { test(t, servedCatalogue) })
}

func servedCatalogue(t *testing.T) (*store.Store, string) {
	st, dsn := storetest.NewNamed(t)
	serve(t, st)
	return st, dsn
}

// served maps a store to the API that scanAt writes it through.
var served sync.Map

// servedAPI is bank serve's API over one test's store.
type servedAPI struct {
	url         string
	write, read string
	requests    atomic.Int64
	// down drops every request's connection unanswered, as an outage does.
	down atomic.Bool
	scan Catalogue
}

func serve(t *testing.T, st *store.Store) *servedAPI {
	t.Helper()
	dir := t.TempDir()
	issued := server.Tokens(dir)
	write, err := issued.New("scanner", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	read, err := issued.New("agent", tokens.Read)
	if err != nil {
		t.Fatal(err)
	}
	bank := server.New(st, nil, dir, nil)
	handler := bank.Handler()
	s := &servedAPI{write: write, read: read}
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if s.down.Load() {
			if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
				conn.Close()
			}
			return
		}
		handler.ServeHTTP(w, r)
	}))
	s.url = listener.URL
	s.scan = Remote(client.New(s.url, write), func(Wait) {})
	served.Store(st, s)
	t.Cleanup(func() {
		served.Delete(st)
		listener.Close()
		if err := bank.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func catalogueOf(st *store.Store) Catalogue {
	if s, ok := served.Load(st); ok {
		return s.(*servedAPI).scan
	}
	return Local(st)
}
