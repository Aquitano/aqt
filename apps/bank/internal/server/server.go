// Package server exposes the archive over HTTP so the CLI can run on a laptop
// while Postgres and the blob store stay on one box — otherwise imports split
// rows and blobs across two machines.
//
// There is no TLS here on purpose: bind to a Tailscale address and let the
// tailnet be the transport security. Bearer tokens guard every /v1 route.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/disks/session"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/find"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// reader is the read side of the store, an interface only so the handlers can
// be exercised without a database.
type reader interface {
	ListMailboxes(context.Context, string) ([]store.Mailbox, error)
	BrowseThreads(context.Context, store.BrowseOpts) ([]store.ThreadGroup, error)
	find.Lists
	find.Dated
	AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error)
	GetMessageByRef(ctx context.Context, cited ref.Message) (store.Message, []store.Attachment, error)
	GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
	ListContacts(ctx context.Context) ([]store.Contact, error)
	GetContact(ctx context.Context, name string) (store.Contact, error)
	ContactSourceCounts(ctx context.Context, contactID int64) ([]store.ContactSourceCount, error)
	ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.MessageDetail, error)
	SuggestIdentities(ctx context.Context, limit int) ([]store.IdentitySuggestion, error)
	Query(ctx context.Context, query string, limit int) (store.QueryResult, error)
}

type Server struct {
	db       *store.Store // importers need the concrete store
	read     reader
	blobs    *blob.Store
	kinds    importer.Registry
	dataDir  string
	sessions *session.Manager
}

// New serves the archive and the files on disks in db. The kinds are the
// import kinds it serves a route for. Scans that write through the API spool
// large archive listings below dataDir.
func New(db *store.Store, blobs *blob.Store, dataDir string, kinds importer.Registry) *Server {
	return &Server{db: db, read: db, blobs: blobs, kinds: kinds, dataDir: dataDir, sessions: session.New(db, filepath.Join(dataDir, "scans"))}
}

// Close ends the scans still writing through the API as interrupted.
func (s *Server) Close() error { return s.sessions.Close() }

func Tokens(dataDir string) tokens.Store {
	return tokens.Store{Path: filepath.Join(dataDir, "tokens"), Prefix: "bank_"}
}

const mintCommand = "bank token new <name>"

// Sized for Gmail Takeout mboxes, which routinely exceed 1 GiB.
const maxUpload = 16 << 30

var errUnavailable = httpapi.Kind{Tag: "Unavailable", Status: http.StatusServiceUnavailable,
	Doc: "The server cannot reach its database."}

// Handler serves every operation to the holders of a token, the OpenAPI
// document at /openapi.json and an unauthenticated /healthz.
func (s *Server) Handler() http.Handler {
	return s.handler(true)
}

// LocalHandler is Handler without tokens, for a client in this process. That
// client opened the database itself, so it already holds full access; it must
// never be served on a socket.
func (s *Server) LocalHandler() http.Handler {
	return s.handler(false)
}

func (s *Server) handler(requireToken bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	s.registerAPI(mux, requireToken)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		httpapi.Write(w, httpapi.NotFound.New("no route for "+r.Method+" "+r.URL.Path))
	})
	return mux
}

type healthReport struct {
	OK            bool              `json:"ok"`
	SchemaVersion int32             `json:"schema_version"`
	Queues        []store.QueueStat `json:"queues"`
}

// health checks the database with a short deadline and says which schema
// version the server runs on and how much work waits in each job queue.
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if s.db == nil {
		httpapi.Write(w, errUnavailable.New("no database is configured"))
		return
	}
	version, err := s.db.SchemaVersion(ctx)
	if err != nil {
		slog.Error("health check", "error", err)
		httpapi.Write(w, errUnavailable.New("the database does not answer"))
		return
	}
	queues, err := s.db.QueueStats(ctx)
	if err != nil {
		slog.Error("health check", "error", err)
		httpapi.Write(w, errUnavailable.New("the job queue does not answer"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(healthReport{OK: true, SchemaVersion: version, Queues: queues})
}

// ListenAndServe serves until ctx ends, then drains: the listener stops,
// requests in flight get their time, open scans end as interrupted, and only
// then does the caller close the database pools.
func (s *Server) ListenAndServe(ctx context.Context, addr string) (err error) {
	defer func() { err = errors.Join(err, s.Close()) }()
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	return Run(ctx, srv)
}

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return time.Time{}, fail.Invalidf("invalid date %q, want YYYY-MM-DD", s)
	}
	return t, nil
}
