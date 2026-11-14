package scan

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humago"

	atticapi "github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// newCatalogue gives a test a catalogue of its own and its database.
type newCatalogue func(*testing.T) (*store.Store, string)

// eachTransport runs a test twice: scanning into the database from this
// process, and through bank serve's API as a scan on another machine does.
func eachTransport(t *testing.T, test func(*testing.T, newCatalogue)) {
	t.Run("local", func(t *testing.T) { test(t, storetest.NewCatalogue) })
	t.Run("http", func(t *testing.T) { test(t, servedCatalogue) })
}

func servedCatalogue(t *testing.T) (*store.Store, string) {
	st, dsn := storetest.NewCatalogue(t)
	serve(t, st)
	return st, dsn
}

// served maps a store to the API that scanAt writes it through.
var served sync.Map

// server is bank serve's catalogue API over one test's store.
type server struct {
	url         string
	write, read string
	sessions    *session.Manager
	requests    atomic.Int64
	// down drops every request's connection unanswered, as an outage does.
	down atomic.Bool
	scan Catalogue
}

func serve(t *testing.T, st *store.Store) *server {
	t.Helper()
	issued := tokens.Store{Path: filepath.Join(t.TempDir(), "tokens")}
	write, err := issued.New("scanner", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	read, err := issued.New("agent", tokens.Read)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	api := humago.New(mux, httpapi.Config("test", "", "bank token new <name>"))
	api.UseMiddleware(httpapi.RequireToken(api, issued, "bank token new <name>"))
	s := &server{write: write, read: read, sessions: session.New(st, t.TempDir())}
	atticapi.Register(api, st, s.sessions)
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.requests.Add(1)
		if s.down.Load() {
			if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
				conn.Close()
			}
			return
		}
		mux.ServeHTTP(w, r)
	}))
	s.url = listener.URL
	s.scan = Remote(client.New(s.url, write), func(Wait) {})
	served.Store(st, s)
	t.Cleanup(func() {
		served.Delete(st)
		listener.Close()
		if err := s.sessions.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func catalogueOf(st *store.Store) Catalogue {
	if s, ok := served.Load(st); ok {
		return s.(*server).scan
	}
	return Local(st)
}
