package ingest

import (
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

const (
	maxEventBody     = 4 << 20
	maxEventsPerPost = 1000
	maxAppChars      = 256
	maxTitleChars    = 512
)

// wireEvent is the union of every event shape. Ids and times stay strings so
// one malformed event is dropped and counted instead of failing the batch,
// which would leave it stuck in the extension's outbox forever.
type wireEvent struct {
	Type           string `json:"type"`
	ID             string `json:"id"`
	URL            string `json:"url"`
	Title          string `json:"title"`
	StartedAt      string `json:"started_at"`
	NavigationType string `json:"navigation_type"`
	Referrer       string `json:"referrer"`
	TabSessionID   string `json:"tab_session_id"`
	Private        bool   `json:"private"`
	PageViewID     string `json:"page_view_id"`
	AppName        string `json:"app_name"`
	BundleID       string `json:"bundle_id"`
	WindowTitle    string `json:"window_title"`
	At             string `json:"at"`
	EndedAt        string `json:"ended_at"`
	Reason         string `json:"reason"`
}

var (
	navigationTypes = map[string]bool{"load": true, "spa": true, "reload": true, "back_forward": true}
	endReasons      = map[string]bool{"tab_switch": true, "window_blur": true, "app_switch": true, "window_change": true,
		"idle": true, "navigation": true, "tab_closed": true, "unknown": true}
)

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	var batch struct {
		DeviceID uuid.UUID   `json:"device_id"`
		Events   []wireEvent `json:"events"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxEventBody)).Decode(&batch); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if batch.DeviceID == uuid.Nil {
		writeErr(w, http.StatusBadRequest, "missing device_id")
		return
	}
	if len(batch.Events) > maxEventsPerPost {
		writeErr(w, http.StatusBadRequest, "too many events in one batch")
		return
	}
	events, dropped := parseEvents(batch.Events)
	res, err := s.store.ApplyEvents(r.Context(), batch.DeviceID, events)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	accepted := 0
	for typ, n := range res.Accepted {
		accepted += n
		s.metrics.EventsIngested.WithLabelValues(typ).Add(float64(n))
	}
	for typ, n := range res.Dropped {
		dropped[typ] += n
	}
	total := 0
	for typ, n := range dropped {
		total += n
		s.metrics.EventsDropped.WithLabelValues(typ).Add(float64(n))
	}
	writeJSON(w, http.StatusOK, map[string]int{"accepted": accepted, "dropped": total})
}

func parseEvents(wire []wireEvent) (store.Events, map[string]int) {
	var ev store.Events
	dropped := map[string]int{}
	for _, e := range wire {
		ok := false
		switch e.Type {
		case store.EventPageView:
			if pv, valid := parsePageView(e); valid {
				ev.PageViews = append(ev.PageViews, pv)
				ok = true
			}
		case store.EventSpanStart:
			if sp, valid := parseSpanStart(e); valid {
				ev.SpanStarts = append(ev.SpanStarts, sp)
				ok = true
			}
		case store.EventSpanHeartbeat:
			id, at := parseUUID(e.ID), parseTime(e.At)
			if ok = id != uuid.Nil && !at.IsZero(); ok {
				ev.Heartbeats = append(ev.Heartbeats, store.SpanHeartbeatEvent{ID: id, At: at})
			}
		case store.EventSpanEnd:
			id, at := parseUUID(e.ID), parseTime(e.EndedAt)
			if ok = id != uuid.Nil && !at.IsZero(); ok {
				reason := e.Reason
				if !endReasons[reason] {
					reason = "unknown"
				}
				ev.SpanEnds = append(ev.SpanEnds, store.SpanEndEvent{ID: id, EndedAt: at, Reason: reason})
			}
		default:
			dropped["unknown"]++
			continue
		}
		if !ok {
			dropped[e.Type]++
		}
	}
	return ev, dropped
}

// parseSpanStart takes a browser span (page_view_id) or a desktop one
// (app_name). Both or neither is malformed.
func parseSpanStart(e wireEvent) (store.SpanStartEvent, bool) {
	id, pv, at := parseUUID(e.ID), parseUUID(e.PageViewID), parseTime(e.StartedAt)
	app := truncate(e.AppName, maxAppChars)
	if id == uuid.Nil || at.IsZero() || (pv == uuid.Nil) == (app == "") {
		return store.SpanStartEvent{}, false
	}
	sp := store.SpanStartEvent{ID: id, PageViewID: pv, StartedAt: at}
	if app != "" {
		sp.AppName = app
		sp.BundleID = truncate(e.BundleID, maxAppChars)
		sp.WindowTitle = truncate(e.WindowTitle, maxTitleChars)
	}
	return sp, true
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max])
}

func parsePageView(e wireEvent) (store.PageViewEvent, bool) {
	id, at := parseUUID(e.ID), parseTime(e.StartedAt)
	key, ok := urlKey(e.URL)
	if id == uuid.Nil || at.IsZero() || !ok || !navigationTypes[e.NavigationType] {
		return store.PageViewEvent{}, false
	}
	pv := store.PageViewEvent{ID: id, URL: key, StartedAt: at, NavigationType: e.NavigationType,
		TabSessionID: e.TabSessionID, Private: e.Private}
	if !e.Private {
		pv.Title = e.Title
	}
	if ref, ok := urlKey(e.Referrer); ok {
		pv.Referrer = &ref
	}
	return pv, true
}

func urlKey(raw string) (store.URLKey, bool) {
	normalized, host, err := urlnorm.Normalize(raw)
	if err != nil {
		return store.URLKey{}, false
	}
	return store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host}, true
}

func parseUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
