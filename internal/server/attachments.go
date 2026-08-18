package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/aquitano/aqt-bank/internal/extract"
	"github.com/aquitano/aqt-bank/internal/store"
)

// Attachment text is writable over HTTP, not just readable, because the
// machine that can run an OCR model is rarely the VPS. A laptop lists what
// needs text, fetches the bytes through GET /v1/blobs/{sha256}, runs whatever
// it likes, and puts the result back.

// maxTextUpload bounds what is read off the wire. What is storable is
// store.MaxAttachmentTextChars, which is smaller: reading past it is what lets
// an oversized body be refused with a message saying how far over it is,
// rather than as a truncated read.
const maxTextUpload = 8 << 20

func (s *Server) handleAttachmentList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, err := parseInt(q.Get("limit"), 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	o := store.ListBlobsOpts{Source: q.Get("source"), Limit: limit}
	if status := q.Get("status"); status != "" {
		o.Statuses = strings.Split(status, ",")
	}
	blobs, err := s.db.ListBlobs(r.Context(), o)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, blobs)
}

func (s *Server) handleAttachmentStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.db.ExtractionStats(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

// pathDigest validates the {sha256} path segment before it reaches a query or
// a file path, and reports whether the handler should carry on.
func pathDigest(w http.ResponseWriter, r *http.Request) (string, bool) {
	sum := r.PathValue("sha256")
	if !sha256Hex.MatchString(sum) {
		writeErr(w, http.StatusBadRequest, "sha256 must be 64 lowercase hex characters")
		return "", false
	}
	return sum, true
}

func (s *Server) handleAttachmentTextGet(w http.ResponseWriter, r *http.Request) {
	sum, ok := pathDigest(w, r)
	if !ok {
		return
	}
	bt, err := s.db.GetBlobText(r.Context(), sum)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no extracted text for "+sum)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, bt)
}

// handleAttachmentTextPut stores text produced somewhere else. The status is
// taken from the request when it names one — an extraction run against a
// remote archive reports its real outcome — and defaults to "manual", which
// automatic passes never overwrite.
func (s *Server) handleAttachmentTextPut(w http.ResponseWriter, r *http.Request) {
	sum, ok := pathDigest(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	if status == "" {
		status = string(extract.StatusManual)
	}
	// A status nothing recognizes strands the row: no default pass selects it
	// again, and the content looks read when it never was. Storing "pending"
	// is the same mistake spelled correctly — it means the absence of a row.
	if err := extract.ValidStoredStatus(status); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// Text for a digest the archive never saw would be unreachable by any
	// message and invisible to every later refresh.
	known, err := s.db.KnownAttachment(r.Context(), sum)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !known {
		writeErr(w, http.StatusNotFound, "no attachment with sha256 "+sum)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTextUpload))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	// Storing it would silently halve a transcription, which is the worst
	// place to lose text: nothing else can produce it again.
	if len(body) > store.MaxAttachmentTextChars {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf(
			"text is %d bytes, over the %d a row holds", len(body), store.MaxAttachmentTextChars))
		return
	}
	if err := s.db.PutBlobText(r.Context(), store.BlobText{
		SHA256:    sum,
		Text:      string(body),
		Extractor: q.Get("extractor"),
		Status:    status,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sha256": sum, "status": status})
}

func (s *Server) handleAttachmentTextDelete(w http.ResponseWriter, r *http.Request) {
	sum, ok := pathDigest(w, r)
	if !ok {
		return
	}
	err := s.db.DeleteBlobText(r.Context(), sum)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no extracted text for "+sum)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sha256": sum, "status": "deleted"})
}

// handleAttachmentRefresh copies extracted text onto the messages that carry
// it. A remote run calls this once at the end rather than after every blob:
// the statement sweeps every message, so per-blob would be quadratic.
func (s *Server) handleAttachmentRefresh(w http.ResponseWriter, r *http.Request) {
	n, err := s.db.RefreshAttachmentText(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"messages_reindexed": n})
}
