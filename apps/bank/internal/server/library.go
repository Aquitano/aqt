package server

import (
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/gabriel-vasile/mimetype"
)

func libraryPage(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	q := r.URL.Query()
	limit, err := parseInt(q.Get("limit"), 50)
	if err != nil || limit < 1 || limit > 100 {
		writeErr(w, 400, "limit must be 1-100")
		return 0, 0, false
	}
	offset, err := parseInt(q.Get("offset"), 0)
	if err != nil || offset < 0 || offset > store.MaxSearchOffset {
		writeErr(w, 400, "invalid offset")
		return 0, 0, false
	}
	return limit, offset, true
}

func (s *Server) handleAttachmentPreview(w http.ResponseWriter, r *http.Request) {
	sum, ok := pathDigest(w, r)
	if !ok {
		return
	}
	known, err := s.db.KnownAttachment(r.Context(), sum)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if !known {
		writeErr(w, 404, "unknown attachment")
		return
	}
	f, err := os.Open(s.blobs.Path(sum))
	if os.IsNotExist(err) {
		writeErr(w, 404, "attachment file is missing")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	defer f.Close()
	head := make([]byte, 3072)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, 500, err.Error())
		return
	}
	typ := http.DetectContentType(head[:n])
	if typ == "application/octet-stream" {
		typ = mimetype.Detect(head[:n]).String()
	}
	switch typ {
	case "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "audio/aac", "audio/flac", "audio/x-flac", "audio/ogg", "audio/wave", "audio/aiff", "audio/midi", "video/mp4", "video/webm", "video/ogg", "video/avi":
	default:
		writeErr(w, 415, "preview uses extracted text for this file type")
		return
	}
	info, err := f.Stat()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", typ)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'")
	http.ServeContent(w, r, "preview", info.ModTime(), f)
}
