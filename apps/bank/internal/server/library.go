package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/aquitano/aqt/apps/bank/internal/store"
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

func (s *Server) handleLibrary(w http.ResponseWriter, r *http.Request) {
	limit, offset, ok := libraryPage(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	o := store.AttachmentFilter{Filename: q.Get("q"), Text: q.Get("text"), FileType: q.Get("type"), Person: q.Get("person"), Limit: limit, Offset: offset}
	var err error
	if o.Since, err = parseDate(q.Get("since")); err != nil {
		writeErr(w, 400, "invalid since")
		return
	}
	if o.Until, err = parseDate(q.Get("until")); err != nil {
		writeErr(w, 400, "invalid until")
		return
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Since.Before(o.Until) {
		writeErr(w, 400, "until must be after since")
		return
	}
	files, err := s.db.AttachmentLibrary(r.Context(), o)
	if err != nil {
		var missing *store.ErrNoContact
		if errors.As(err, &missing) {
			writeErr(w, 400, err.Error())
		} else {
			writeErr(w, 500, err.Error())
		}
		return
	}
	writeJSON(w, 200, files)
}

func (s *Server) handleAttachmentMessages(w http.ResponseWriter, r *http.Request) {
	sum, ok := pathDigest(w, r)
	if !ok {
		return
	}
	limit, offset, ok := libraryPage(w, r)
	if !ok {
		return
	}
	messages, err := s.db.AttachmentMessages(r.Context(), sum, offset, limit)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, messages)
}

func (s *Server) handleImportReports(w http.ResponseWriter, r *http.Request) {
	limit, _, ok := libraryPage(w, r)
	if !ok {
		return
	}
	before, err := parseInt(r.URL.Query().Get("before"), 0)
	if err != nil || before < 0 {
		writeErr(w, 400, "invalid before")
		return
	}
	reports, err := s.db.ImportReports(r.Context(), int64(before), limit)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, reports)
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
	head := make([]byte, 512)
	n, err := f.Read(head)
	if err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, 500, err.Error())
		return
	}
	typ := http.DetectContentType(head[:n])
	switch typ {
	case "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp":
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

func (s *Server) handleMessageParent(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, 400, "invalid message id")
		return
	}
	m, err := s.db.MessageParent(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "parent message is not in the archive")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, m)
}

func (s *Server) handleMessageBranch(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, 400, "invalid message id")
		return
	}
	branch, err := s.db.MessageBranch(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "message is not in the archive")
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, branch)
}
