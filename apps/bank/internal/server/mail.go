package server

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func parseMailFilters(query url.Values) (int64, string, *bool, error) {
	var mailboxID int64
	var attachment *bool
	if raw := query.Get("mailbox_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 || query.Get("source") == "" {
			return 0, "", nil, fmt.Errorf("mailbox_id must be positive and requires a source")
		}
		mailboxID = id
	}
	if query.Has("has_attachment") {
		raw := query.Get("has_attachment")
		if raw != "true" && raw != "false" {
			return 0, "", nil, fmt.Errorf("has_attachment must be true or false")
		}
		value := raw == "true"
		attachment = &value
	}
	return mailboxID, query.Get("subject"), attachment, nil
}

func (s *Server) handleMailConflict(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	source := query.Get("source")
	if err := archive.ValidSource(source); err != nil {
		writeErr(writer, 400, err.Error())
		return
	}
	before, err := strconv.ParseInt(query.Get("before"), 10, 64)
	if query.Get("before") == "" {
		before, err = 0, nil
	}
	if err != nil || before < 0 {
		writeErr(writer, 400, "invalid before cursor")
		return
	}
	limit, err := parseInt(query.Get("limit"), 100)
	if err != nil || limit < 1 || limit > store.MaxThreadMessages {
		writeErr(writer, 400, "invalid limit")
		return
	}
	page, err := s.read.MailConflictMessages(request.Context(), source, request.PathValue("id"), before, limit)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(writer, 404, err.Error())
		return
	}
	if err != nil {
		writeErr(writer, 500, err.Error())
		return
	}
	writeJSON(writer, 200, page)
}

func (s *Server) handleMailboxes(writer http.ResponseWriter, request *http.Request) {
	source := request.URL.Query().Get("source")
	if err := archive.ValidSource(source); err != nil {
		writeErr(writer, 400, err.Error())
		return
	}
	mailboxes, err := s.read.ListMailboxes(request.Context(), source)
	if err != nil {
		writeErr(writer, 500, err.Error())
		return
	}
	writeJSON(writer, 200, mailboxes)
}
