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

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// reader is the read side of the store, an interface only so the handlers can
// be exercised without a database.
type reader interface {
	ListMailboxes(context.Context, string) ([]store.Mailbox, error)
	BrowseThreads(context.Context, store.BrowseOpts) ([]store.ThreadGroup, error)
	Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error)
	SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error)
	AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error)
	GetMessageByRef(ctx context.Context, cited ref.Message) (store.Message, []store.Attachment, error)
	GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error)
	MailConflictMessages(context.Context, string, string, ref.Message, int) (store.Thread, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
	ListContacts(ctx context.Context) ([]store.Contact, error)
	GetContact(ctx context.Context, name string) (store.Contact, error)
	ContactSourceCounts(ctx context.Context, contactID int64) ([]store.ContactSourceCount, error)
	ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.MessageDetail, error)
	SuggestIdentities(ctx context.Context, limit int) ([]store.IdentitySuggestion, error)
	Query(ctx context.Context, query string, limit int) (store.QueryResult, error)
}

// Catalogue is the file catalogue: its share of combined search, the timeline
// and refs, and its own operations below /v1/disk. Close ends the scans that
// write through them.
type Catalogue interface {
	catalog.Catalogue
	Register(huma.API)
	Close() error
}

type Server struct {
	db        *store.Store // importers need the concrete store
	read      reader
	blobs     *blob.Store
	kinds     importer.Registry
	dataDir   string
	catalogue Catalogue
}

// New serves the archive in db and the files on disks in catalogue. The
// kinds are the import kinds it serves a route for.
func New(db *store.Store, catalogue Catalogue, blobs *blob.Store, dataDir string, kinds importer.Registry) *Server {
	return &Server{db: db, read: db, catalogue: catalogue, blobs: blobs, kinds: kinds, dataDir: dataDir}
}

func Tokens(dataDir string) tokens.Store {
	return tokens.Store{Path: filepath.Join(dataDir, "tokens"), Prefix: "bank_"}
}

const mintCommand = "bank token new <name>"

// Sized for Gmail Takeout mboxes, which routinely exceed 1 GiB.
const maxUpload = 16 << 30

var errUnavailable = httpapi.Kind{Tag: "Unavailable", Status: http.StatusServiceUnavailable,
	Doc: "The server cannot reach its database."}

// Handler serves every operation, the OpenAPI document at /openapi.json and
// an unauthenticated /healthz.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	s.registerAPI(mux)
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
	defer func() { err = errors.Join(err, s.catalogue.Close()) }()
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
