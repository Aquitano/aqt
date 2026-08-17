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
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/store"
)

// reader is the read side of the store, an interface only so the handlers can
// be exercised without a database.
type reader interface {
	Search(ctx context.Context, query string, o store.SearchOpts) ([]store.Message, error)
	GetMessage(ctx context.Context, id int64) (store.Message, []store.Attachment, error)
	Stats(ctx context.Context) ([]store.SourceStats, error)
}

type Server struct {
	db         *store.Store // importers need the concrete store
	read       reader
	blobs      *blob.Store
	archiveDir string
	dataDir    string
}

func New(db *store.Store, blobs *blob.Store, dataDir, archiveDir string) *Server {
	return &Server{db: db, read: db, blobs: blobs, archiveDir: archiveDir, dataDir: dataDir}
}

const maxUpload = 1 << 30

func (s *Server) Handler() http.Handler {
	v1 := http.NewServeMux()
	v1.HandleFunc("GET /v1/search", s.handleSearch)
	v1.HandleFunc("GET /v1/messages/{id}", s.handleMessage)
	v1.HandleFunc("GET /v1/blobs/{sha256}", s.handleBlob)
	v1.HandleFunc("GET /v1/stats", s.handleStats)
	v1.HandleFunc("POST /v1/import/{kind}", s.handleImport)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.Handle("/v1/", s.requireToken(v1))
	return mux
}

func (s *Server) ListenAndServe(addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	return srv.ListenAndServe()
}

func (s *Server) requireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == r.Header.Get("Authorization") || !VerifyToken(s.dataDir, token) {
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
	o := store.SearchOpts{Source: q.Get("source"), From: q.Get("from"), Fuzzy: 1, Limit: 20}
	var err error
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
	msgs, err := s.read.Search(r.Context(), query, o)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	m, atts, err := s.read.GetMessage(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, fmt.Sprintf("message %d: %v", id, err))
		return
	}
	writeJSON(w, http.StatusOK, store.MessageDetail{Message: m, Attachments: atts})
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) handleBlob(w http.ResponseWriter, r *http.Request) {
	sum := r.PathValue("sha256")
	// Validated before it ever reaches a filepath.Join, so no traversal is possible.
	if !sha256Hex.MatchString(sum) {
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
	io.Copy(w, f)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.read.Stats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
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
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
