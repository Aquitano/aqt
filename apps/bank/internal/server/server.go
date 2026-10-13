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
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/store"
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
}

func New(db *store.Store, blobs *blob.Store, dataDir, archiveDir string) *Server {
	s := &Server{db: db, read: db, blobs: blobs, archiveDir: archiveDir, dataDir: dataDir}
	// Uploads staged by a process that died are nobody's to clean up later.
	if err := pruneUploads(dataDir, uploadMaxAge); err != nil {
		fmt.Fprintf(os.Stderr, "bank: pruning abandoned uploads: %v\n", err)
	}
	return s
}

// Sized for Gmail Takeout mboxes, which routinely exceed 1 GiB.
const maxUpload = 16 << 30

func (s *Server) Handler() http.Handler {
	v1 := http.NewServeMux()
	s.registerLibraryRoutes(v1)
	v1.HandleFunc("GET /v1/search", s.handleSearch)
	v1.HandleFunc("GET /v1/mailboxes", s.handleMailboxes)
	v1.HandleFunc("GET /v1/threads", s.handleBrowseThreads)
	v1.HandleFunc("GET /v1/messages/{id}", s.handleMessage)
	v1.HandleFunc("GET /v1/threads/{id}", s.handleThread)
	v1.HandleFunc("GET /v1/mail-conflicts/{id}", s.handleMailConflict)
	v1.HandleFunc("GET /v1/blobs/{sha256}", s.handleBlob)
	v1.HandleFunc("GET /v1/stats", s.handleStats)
	v1.HandleFunc("PUT /v1/sources/{source}/coverage", s.handleCoverage)
	v1.HandleFunc("POST /v1/query", s.handleQuery)
	v1.HandleFunc("GET /v1/contacts", s.handleContactList)
	v1.HandleFunc("POST /v1/contacts", s.handleContactCreate)
	v1.HandleFunc("POST /v1/contacts/import", s.handleContactImport)
	v1.HandleFunc("GET /v1/contacts/suggest", s.handleContactSuggest)
	v1.HandleFunc("GET /v1/contacts/{name}", s.handleContactShow)
	v1.HandleFunc("DELETE /v1/contacts/{name}", s.handleContactDelete)
	v1.HandleFunc("GET /v1/contacts/{name}/messages", s.handleContactMessages)
	v1.HandleFunc("POST /v1/contacts/{name}/aliases", s.handleAliasAdd)
	v1.HandleFunc("DELETE /v1/contacts/{name}/aliases", s.handleAliasRemove)
	v1.HandleFunc("GET /v1/messages/{id}/branch", s.handleMessageBranch)
	v1.HandleFunc("GET /v1/messages/{id}/parent", s.handleMessageParent)
	v1.HandleFunc("GET /v1/attachments/{sha256}/preview", s.handleAttachmentPreview)
	v1.HandleFunc("GET /v1/import-reports", s.handleImportReports)
	v1.HandleFunc("GET /v1/attachment-library", s.handleLibrary)
	v1.HandleFunc("GET /v1/attachments/{sha256}/messages", s.handleAttachmentMessages)
	v1.HandleFunc("GET /v1/attachments", s.handleAttachmentList)
	v1.HandleFunc("GET /v1/attachments/stats", s.handleAttachmentStats)
	v1.HandleFunc("POST /v1/attachments/refresh", s.handleAttachmentRefresh)
	v1.HandleFunc("GET /v1/attachments/{sha256}/text", s.handleAttachmentTextGet)
	v1.HandleFunc("PUT /v1/attachments/{sha256}/text", s.handleAttachmentTextPut)
	v1.HandleFunc("DELETE /v1/attachments/{sha256}/text", s.handleAttachmentTextDelete)
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
	mux.Handle("/v1/", s.requireToken(v1))
	return mux
}

func (s *Server) ListenAndServe(ctx context.Context, addr string) error {
	workCtx, cancelWork := context.WithCancel(context.Background())
	s.extraction.ctx = workCtx
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

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		const prefix = "bearer " // scheme is case-insensitive per RFC 7235
		auth := r.Header.Get("Authorization")
		if len(auth) <= len(prefix) || !strings.EqualFold(auth[:len(prefix)], prefix) || !VerifyToken(s.dataDir, auth[len(prefix):]) {
			writeErr(w, http.StatusUnauthorized, "invalid or missing bearer token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	query := q.Get("q")
	if query == "" {
		writeErr(w, http.StatusBadRequest, "missing q")
		return
	}
	o := store.SearchOpts{Source: q.Get("source"), From: q.Get("from"), To: q.Get("to"),
		Person: q.Get("person"), Match: q.Get("match"), Fuzzy: 1, Limit: 20}
	var err error
	if o.MailboxID, o.Subject, o.HasAttachment, err = parseMailFilters(q); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if o.Since, err = parseDate(q.Get("since")); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if o.Until, err = parseDate(q.Get("until")); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if o.Fuzzy, err = parseInt(q.Get("fuzzy"), o.Fuzzy); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid fuzzy")
		return
	}
	if o.Limit, err = parseInt(q.Get("limit"), o.Limit); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	if o.Offset, err = parseInt(q.Get("offset"), 0); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid offset")
		return
	}
	// Validated here as well as in the store so a bad request is a 400 with a
	// usage message, not a 500 carrying a database error.
	if err := o.ValidateQuery(query); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	msgs, err := s.read.Search(r.Context(), query, o)
	if errors.Is(err, store.ErrMailboxSource) {
		writeErr(w, 400, err.Error())
		return
	}
	var noContact *store.ErrNoContact
	if errors.As(err, &noContact) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// handleMessage addresses a message by row id or by its stable ref. A ref is
// tried first: it is 12 hex characters, so an all-digit one would otherwise
// parse as a row id no archive this size will ever have.
func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request) {
	arg := r.PathValue("id")
	var m store.Message
	var atts []store.Attachment
	var err error
	if store.ValidRef(arg) == nil {
		m, atts, err = s.read.GetMessageByRef(r.Context(), arg)
	} else {
		id, parseErr := strconv.ParseInt(arg, 10, 64)
		if parseErr != nil {
			writeErr(w, http.StatusBadRequest, "invalid id")
			return
		}
		m, atts, err = s.read.GetMessage(r.Context(), id)
	}
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, fmt.Sprintf("no message %s", arg))
		return
	}
	if err != nil {
		// A message store that cannot answer is not a missing message: a 404
		// here would teach every client to treat an outage as an empty archive.
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("message %s: %v", arg, err))
		return
	}
	writeJSON(w, http.StatusOK, store.MessageDetail{Message: m, Attachments: atts})
}

func (s *Server) handleThread(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, err := parseInt(q.Get("limit"), 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	o := store.ThreadOpts{Limit: limit}
	if raw := q.Get("current"); raw != "" {
		o.Current, err = strconv.ParseBool(raw)
		if err != nil {
			writeErr(w, 400, "invalid current")
			return
		}
	}
	for name, dst := range map[string]*int64{"before": &o.Before, "after": &o.After, "around": &o.Around} {
		if raw := q.Get(name); raw != "" {
			*dst, err = strconv.ParseInt(raw, 10, 64)
			if err != nil || *dst <= 0 {
				writeErr(w, http.StatusBadRequest, "invalid "+name)
				return
			}
		}
	}
	if raw := q.Get("latest"); raw != "" {
		o.Latest, err = strconv.ParseBool(raw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "invalid latest")
			return
		}
	}
	if err := o.Validate(); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	thread, err := s.read.GetThreadPage(r.Context(), q.Get("source"), r.PathValue("id"), o)
	var ambiguous *store.AmbiguousThreadError
	var conflict *store.MailThreadConflictError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, thread)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, fmt.Sprintf("no thread %q", r.PathValue("id")))
	case errors.As(err, &ambiguous):
		writeErr(w, http.StatusBadRequest, err.Error())
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, conflict)
	default:
		writeErr(w, http.StatusInternalServerError, err.Error())
	}
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

// handleQuery runs one read-only ad-hoc SQL statement. Safety lives in the
// store (READ ONLY transaction, statement timeout, row cap); this handler
// only separates "your SQL is wrong" (400) from "the archive is broken" (500).
func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SQL   string `json:"sql"`
		Limit int    `json:"limit"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if strings.TrimSpace(req.SQL) == "" {
		writeErr(w, http.StatusBadRequest, "missing sql")
		return
	}
	res, err := s.read.Query(r.Context(), req.SQL, req.Limit)
	var bad *store.BadQueryError
	if errors.As(err, &bad) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.read.Stats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// handleCoverage records what a source is known to hold. An empty text clears
// the note, which is why this is a PUT rather than two routes.
func (s *Server) handleCoverage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.db.SetCoverage(r.Context(), r.PathValue("source"), body.Text); err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"source": r.PathValue("source"), "coverage": body.Text})
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

func parseInt(s string, def int) (int, error) {
	if s == "" {
		return def, nil
	}
	return strconv.Atoi(s)
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
