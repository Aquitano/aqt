// Package ingest is the HTTP side: events and captures in from the
// extension, rules and search out. The Origin check keeps a web page from
// posting here; a bearer token is required as well once an OIDC issuer is
// configured, and without one only loopback Host headers are served.
package ingest

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/auth"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

type Store interface {
	Ping(ctx context.Context) error
	ApplyEvents(ctx context.Context, deviceID uuid.UUID, ev store.Events) (store.EventResult, error)
	InsertCapture(ctx context.Context, in store.CaptureInput) (store.CaptureResult, error)
	Search(ctx context.Context, o store.SearchOpts) ([]store.Hit, error)
	URLVisits(ctx context.Context, urlHash []byte, before time.Time) (store.Visits, error)
	Record(ctx context.Context, id int64) (store.RecordDetail, error)
	Time(ctx context.Context, o store.TimeOpts) ([]store.TimeRow, error)
	Forget(ctx context.Context, t store.ForgetTarget) (store.Forgotten, error)
	Stats(ctx context.Context) (store.Stats, error)
}

type Server struct {
	store       Store
	metrics     *metrics.Metrics
	log         *slog.Logger
	wake        func()
	auth        *auth.Authenticator
	extensionID string
}

// New serves the API. An empty extensionID lets any extension's origin in;
// a set one lets in that extension alone, which is what keeps another
// installed extension from reading search results.
func New(st Store, m *metrics.Metrics, log *slog.Logger, wake func(), a *auth.Authenticator, extensionID string) *Server {
	return &Server{store: st, metrics: m, log: log, wake: wake, auth: a, extensionID: extensionID}
}

const extensionScheme = "chrome-extension://"

func (s *Server) allowedOrigin(origin string) bool {
	if s.extensionID == "" {
		return strings.HasPrefix(origin, extensionScheme)
	}
	return origin == extensionScheme+s.extensionID
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.Handle("GET /metrics", s.metrics.Handler())
	mux.Handle("GET /v1/capture-rules", s.protect(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"rules": extractor.Rules()})
	}))
	mux.Handle("POST /v1/events/batch", s.protect(s.handleEvents))
	mux.Handle("POST /v1/captures", s.protect(s.handleCapture))
	mux.Handle("GET /v1/search", s.protect(s.handleSearch))
	mux.Handle("GET /v1/visits", s.protect(s.handleVisits))
	mux.Handle("GET /v1/records/{id}", s.protect(s.handleRecord))
	mux.Handle("GET /v1/time", s.protect(s.handleTime))
	mux.Handle("POST /v1/forget", s.protect(s.handleForget))
	mux.Handle("GET /v1/stats", s.protect(s.handleStats))
	return s.observe(mux)
}

// protect turns away anything without a token the issuer signed. /healthz and
// /metrics stay open on purpose: Prometheus scrapes one, and the extension
// reads the other to tell "server down" from "signed out", which are
// different states with different fixes.
//
// With auth off, a loopback Host is the credential instead. A DNS-rebound web
// page is same-origin with this server, so its GETs carry no Origin header to
// reject; its Host is still the attacker's name.
func (s *Server) protect(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.Enabled() && !loopbackHost(r.Host) {
			s.log.Warn("non-loopback host without auth", "path", r.URL.Path, "host", r.Host)
			writeErr(w, http.StatusForbidden, "authentication is off, so only loopback hosts are served")
			return
		}
		if err := s.auth.Verify(r.Context(), r); err != nil {
			s.log.Warn("unauthenticated", "path", r.URL.Path, "err", err)
			writeErr(w, http.StatusUnauthorized, "invalid or missing bearer token")
			return
		}
		next(w, r)
	})
}

// observe is the one middleware: origin policy, CORS, request log, metrics.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		requestID, _ := uuid.NewV7()
		rw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		route := "rejected"
		switch origin := r.Header.Get("Origin"); {
		case origin != "" && !s.allowedOrigin(origin):
			writeErr(rw, http.StatusForbidden, "origin not allowed")
		case r.Method == http.MethodOptions:
			route = "preflight"
			allowOrigin(rw, origin)
			rw.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			rw.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
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

func loopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
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

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.Stats(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, stats)
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
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

func (s *Server) handleVisits(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	key, ok := urlKey(q.Get("url"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "url must be an http(s) url")
		return
	}
	before, ok := timeParam(q, "before", time.Time{})
	if !ok {
		writeErr(w, http.StatusBadRequest, "before must be an RFC 3339 time")
		return
	}
	visits, err := s.store.URLVisits(r.Context(), key.Hash, before)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": key.Normalized, "visits": visits})
}

func (s *Server) handleRecord(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "id must be a record id")
		return
	}
	rec, err := s.store.Record(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no record "+strconv.FormatInt(id, 10))
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleTime(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	to, ok := timeParam(q, "to", time.Now())
	if !ok {
		writeErr(w, http.StatusBadRequest, "to must be an RFC 3339 time")
		return
	}
	from, ok := timeParam(q, "from", to.Add(-24*time.Hour))
	if !ok || !from.Before(to) {
		writeErr(w, http.StatusBadRequest, "from must be an RFC 3339 time before to")
		return
	}
	rows, err := s.store.Time(r.Context(), store.TimeOpts{From: from, To: to, By: cmp.Or(q.Get("by"), "host")})
	if errors.Is(err, store.ErrUnknownGrouping) {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}

// timeParam reads an optional RFC 3339 query parameter; ok is false when it is
// there but does not parse.
func timeParam(q url.Values, name string, fallback time.Time) (t time.Time, ok bool) {
	raw := q.Get(name)
	if raw == "" {
		return fallback, true
	}
	t = parseTime(raw)
	return t, !t.IsZero()
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// fail answers a server-side error with a generic message; the error itself,
// which can carry SQL and data, only goes to the log.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	s.log.Error("request failed", "route", r.Pattern, "err", err)
	writeErr(w, http.StatusInternalServerError, "internal server error")
}
