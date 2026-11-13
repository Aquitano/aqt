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
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

// reader is the read side of the store, an interface only so the handlers can
// be exercised without a database.
type reader interface {
	ListMailboxes(context.Context, string) ([]store.Mailbox, error)
	BrowseThreads(context.Context, store.BrowseOpts) ([]store.ThreadGroup, error)
	Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error)
	GetMessage(ctx context.Context, id int64) (store.Message, []store.Attachment, error)
	GetMessageByRef(ctx context.Context, ref string) (store.Message, []store.Attachment, error)
	GetThreadPage(ctx context.Context, source, threadID string, o store.ThreadOpts) (store.Thread, error)
	MailConflictMessages(context.Context, string, string, int64, int) (store.Thread, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
	ListContacts(ctx context.Context) ([]store.Contact, error)
	GetContact(ctx context.Context, name string) (store.Contact, error)
	ContactSourceCounts(ctx context.Context, contactID int64) ([]store.ContactSourceCount, error)
	ContactMessages(ctx context.Context, name string, o store.ContactMessagesOpts) ([]store.MessageDetail, error)
	SuggestIdentities(ctx context.Context, limit int) ([]store.IdentitySuggestion, error)
	Query(ctx context.Context, query string, limit int) (store.QueryResult, error)
}

type Server struct {
	db              *store.Store // importers need the concrete store
	read            reader
	blobs           *blob.Store
	archiveDir      string
	dataDir         string
	jsonReadTimeout time.Duration
	extraction      extraction
	digests         digestPass
	mounts          map[string]http.Handler
	catalogue       catalog.Catalogue
}

// UseCatalogue adds the files on disks to combined search and the timeline.
func (s *Server) UseCatalogue(c catalog.Catalogue) { s.catalogue = c }

// Mount serves another domain's API below prefix, such as /attic. The handler
// sees the full path and does its own authentication.
func (s *Server) Mount(prefix string, h http.Handler) {
	if s.mounts == nil {
		s.mounts = map[string]http.Handler{}
	}
	s.mounts[prefix] = h
}

func New(db *store.Store, blobs *blob.Store, dataDir, archiveDir string) *Server {
	s := &Server{db: db, read: db, blobs: blobs, archiveDir: archiveDir, dataDir: dataDir}
	// Uploads staged by a process that died are nobody's to clean up later.
	if err := pruneUploads(dataDir, uploadMaxAge); err != nil {
		slog.Warn("pruning abandoned uploads", "error", err)
	}
	return s
}

// TokenDomain is the domain a token needs for bank's own routes.
const TokenDomain = "bank"

func Tokens(dataDir string) tokens.Store {
	return tokens.Store{Path: filepath.Join(dataDir, "tokens"), Prefix: "bank_"}
}

// Sized for Gmail Takeout mboxes, which routinely exceed 1 GiB.
const maxUpload = 16 << 30

func (s *Server) Handler() http.Handler {
	v1 := http.NewServeMux()
	s.registerLibraryRoutes(v1)
	v1.HandleFunc("GET /v1/blobs/{sha256}", s.handleBlob)
	v1.HandleFunc("GET /v1/attachments/{sha256}/preview", s.handleAttachmentPreview)
	v1.HandleFunc("PUT /v1/attachments/{sha256}/text", s.handleAttachmentTextPut)
	v1.HandleFunc("POST /v1/import/{kind}", s.handleImport)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if s.db == nil {
			writeErr(w, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		if err := s.db.Ping(ctx); err != nil {
			writeErr(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	s.registerAPI(v1)
	mux.Handle("GET /openapi.json", v1)
	mux.Handle("/v1/", s.requireToken(v1))
	for prefix, h := range s.mounts {
		mux.Handle(prefix+"/", h)
	}
	return mux
}

func (s *Server) ListenAndServe(ctx context.Context, addr string) error {
	workCtx, cancelWork := context.WithCancel(context.Background())
	s.extraction.ctx = workCtx
	s.extraction.done.Go(func() { s.digestBlobs(workCtx) })
	defer func() {
		s.extraction.mu.Lock()
		s.extraction.stopping = true
		cancelWork()
		s.extraction.mu.Unlock()
		s.extraction.done.Wait()
	}()
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	return Run(ctx, srv)
}

// readOnlyPosts take a POST body and only read: ad-hoc SQL runs in read-only
// sessions, and summaries looks up a list of item IDs.
var readOnlyPosts = map[string]bool{"/v1/query": true, "/v1/library/items/summaries": true}

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := httpapi.BearerToken(r)
		var scope tokens.Scope
		if ok {
			var err error
			if scope, ok, err = Tokens(s.dataDir).Verify(token); err != nil {
				slog.Error("read tokens", "error", err)
			}
		}
		if !ok {
			httpapi.Write(w, httpapi.Unauthorized.New("invalid or missing bearer token"))
			return
		}
		write := r.Method != http.MethodGet && r.Method != http.MethodHead && !readOnlyPosts[r.URL.Path]
		if !scope.Allows(TokenDomain, write) {
			httpapi.Write(w, httpapi.Forbidden.New("this token's scope ("+scope.String()+") does not allow the request"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleBlob(w http.ResponseWriter, r *http.Request) {
	sum := r.PathValue("sha256")
	// Validated before it ever reaches a filepath.Join, so no traversal is possible.
	if blob.ValidDigest(sum) != nil {
		writeErr(w, http.StatusBadRequest, "sha256 must be 64 lowercase hex characters")
		return
	}
	f, err := os.Open(s.blobs.Path(sum))
	if os.IsNotExist(err) {
		writeErr(w, http.StatusNotFound, "no such blob")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()
	if info, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = io.Copy(w, f)
}

func parseDate(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q, want YYYY-MM-DD", s)
	}
	return t, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	if status >= 500 {
		slog.Error("HTTP request failed", "status", status, "error", msg)
		msg = http.StatusText(status)
	}
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeCause splits "the client sent something we cannot use" from "this
// server is broken". Collapsing both into 400 tells a caller to fix its input
// when the real answer is that the database or the disk failed.
func writeCause(w http.ResponseWriter, err error) {
	if fail.IsOp(err) {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeErr(w, http.StatusBadRequest, err.Error())
}
