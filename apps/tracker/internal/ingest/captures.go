package ingest

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
)

const (
	MaxCaptureBytes = 25 << 20
	maxMetaBytes    = 64 << 10
)

var captureReasons = map[string]bool{"initial": true, "recapture": true, "manual": true}

type captureMeta struct {
	CaptureID    uuid.UUID `json:"capture_id"`
	PageViewID   uuid.UUID `json:"page_view_id"`
	DeviceID     uuid.UUID `json:"device_id"`
	CapturedAt   time.Time `json:"captured_at"`
	URL          string    `json:"url"`
	Title        string    `json:"title"`
	Extractor    string    `json:"extractor"`
	Reason       string    `json:"reason"`
	RawCharCount int       `json:"raw_char_count"`
}

func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxCaptureBytes)
	meta, html, status, msg := readCapture(r)
	if status != 0 {
		writeErr(w, status, msg)
		return
	}
	key, ok := urlKey(meta.URL)
	if meta.CaptureID == uuid.Nil || meta.PageViewID == uuid.Nil || meta.DeviceID == uuid.Nil ||
		meta.CapturedAt.IsZero() || !ok || !captureReasons[meta.Reason] {
		writeErr(w, http.StatusBadRequest, "meta needs capture_id, page_view_id, device_id, captured_at, an http(s) url and a reason of initial|recapture|manual")
		return
	}
	ext, ok := extractor.Lookup(meta.Extractor)
	if !ok {
		writeErr(w, http.StatusBadRequest, "unknown extractor")
		return
	}
	rule := ext.Rule().WithDefaults()
	if len(html) > rule.MaxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "html exceeds the rule's max_bytes")
		return
	}
	hash := blob.Hash(html)
	payload := blob.Compress(html)
	res, err := s.store.InsertCapture(r.Context(), store.CaptureInput{
		Capture: store.Capture{ID: meta.CaptureID, PageViewID: meta.PageViewID, DeviceID: meta.DeviceID,
			RawHash: hash[:], Extractor: meta.Extractor, CapturedAt: meta.CapturedAt, Reason: meta.Reason,
			URL: meta.URL, BrowserTitle: meta.Title, RawCharCount: meta.RawCharCount},
		URL:     key,
		Blob:    store.RawHTMLBlob{Hash: hash[:], Codec: blob.CodecZstd, RawBytes: len(html), StoredBytes: len(payload), Payload: payload},
		Version: rule.Version,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.metrics.CapturesIngested.WithLabelValues(meta.Extractor, boolLabel(res.Deduplicated)).Inc()
	s.metrics.CaptureRawBytes.Add(float64(len(html)))
	if !res.Deduplicated {
		s.metrics.CaptureStoredBytes.Add(float64(len(payload)))
		s.wake()
	}
	s.log.Info("capture", "capture_id", res.CaptureID, "page_view_id", meta.PageViewID, "host", key.Host,
		"extractor", meta.Extractor, "reason", meta.Reason, "raw_bytes", len(html), "dedup", res.Deduplicated)
	writeJSON(w, http.StatusCreated, map[string]any{
		"capture_id": res.CaptureID, "raw_hash": hex.EncodeToString(res.RawHash), "deduplicated": res.Deduplicated})
}

// readCapture pulls the two multipart parts. status is 0 on success,
// otherwise the HTTP status to answer with.
func readCapture(r *http.Request) (meta captureMeta, html []byte, status int, msg string) {
	mr, err := r.MultipartReader()
	if err != nil {
		return meta, nil, http.StatusBadRequest, "expected multipart/form-data"
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return meta, nil, tooLargeOr(err, http.StatusBadRequest), err.Error()
		}
		switch part.FormName() {
		case "meta":
			if err := json.NewDecoder(io.LimitReader(part, maxMetaBytes)).Decode(&meta); err != nil {
				return meta, nil, http.StatusBadRequest, "invalid meta: " + err.Error()
			}
		case "html":
			if html, err = io.ReadAll(part); err != nil {
				return meta, nil, tooLargeOr(err, http.StatusBadRequest), err.Error()
			}
		}
	}
	if len(html) == 0 {
		return meta, nil, http.StatusBadRequest, "missing html part"
	}
	return meta, html, 0, ""
}

func tooLargeOr(err error, fallback int) int {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return fallback
}

func boolLabel(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
