// Package ingest is the HTTP side: events and captures in from the
// extension, rules and search out. Loopback only and no auth by decision;
// the Origin check is the one guard, so a web page cannot post here.
package ingest

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

type Store interface {
	Ping(ctx context.Context) error
	ApplyEvents(ctx context.Context, deviceID uuid.UUID, ev store.Events) (store.EventResult, error)
	InsertCapture(ctx context.Context, in store.CaptureInput) (store.CaptureResult, error)
	Search(ctx context.Context, o store.SearchOpts) ([]store.Hit, error)
}

type Server struct {
	store   Store
	metrics *metrics.Metrics
	log     *slog.Logger
	wake    func()
}

func New(st Store, m *metrics.Metrics, log *slog.Logger, wake func()) *Server {
	return &Server{store: st, metrics: m, log: log, wake: wake}
}

const extensionOrigin = "chrome-extension://"

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	mux.HandleFunc("GET /v1/capture-rules", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"rules": extractor.Rules()})
	})
	mux.HandleFunc("POST /v1/events/batch", s.handleEvents)
	mux.HandleFunc("POST /v1/captures", s.handleCapture)
	mux.HandleFunc("GET /v1/search", s.handleSearch)
	return s.observe(mux)
}

// observe is the one middleware: origin policy, CORS, request log, metrics.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		requestID, _ := uuid.NewV7()
		rw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		route := "rejected"
		switch origin := r.Header.Get("Origin"); {
		case origin != "" && !strings.HasPrefix(origin, extensionOrigin):
			writeErr(rw, http.StatusForbidden, "origin not allowed")
		case r.Method == http.MethodOptions:
			route = "preflight"
			allowOrigin(rw, origin)
			rw.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			rw.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			rw.Header().Set("Access-Control-Max-Age", "600")
			rw.WriteHeader(http.StatusNoContent)
		default:
			allowOrigin(rw, origin)
			next.ServeHTTP(rw, r)
			if route = r.Pattern; route == "" {
				route = "none"
			}
		}
		elapsed := time.Since(start)
		s.metrics.HTTPRequests.WithLabelValues(route, strconv.Itoa(rw.status)).Inc()
		s.metrics.HTTPDuration.WithLabelValues(route).Observe(elapsed.Seconds())
		s.log.Info("request", "request_id", requestID, "route", route, "status", rw.status,
			"duration_ms", elapsed.Milliseconds())
	})
}

func allowOrigin(w http.ResponseWriter, origin string) {
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]bool{"ok": false, "db": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "db": true})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	o := store.SearchOpts{Query: q.Get("q"), Extractor: q.Get("extractor"), Limit: 20}
	if o.Query == "" {
		writeErr(w, http.StatusBadRequest, "missing q")
		return
	}
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > store.MaxSearchLimit {
			writeErr(w, http.StatusBadRequest, "limit must be 1-"+strconv.Itoa(store.MaxSearchLimit))
			return
		}
		o.Limit = n
	}
	hits, err := s.store.Search(r.Context(), o)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
