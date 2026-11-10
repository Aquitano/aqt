package server

import (
	"fmt"
	"io"
	"net/http"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/blobtext"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
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

// pathDigest validates the {sha256} path segment before it reaches a query or
// a file path, and reports whether the handler should carry on.
func pathDigest(w http.ResponseWriter, r *http.Request) (string, bool) {
	sum := r.PathValue("sha256")
	if blob.ValidDigest(sum) != nil {
		writeErr(w, http.StatusBadRequest, "sha256 must be 64 lowercase hex characters")
		return "", false
	}
	return sum, true
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
	if err := blobtext.ValidStoredStatus(status); err != nil {
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
