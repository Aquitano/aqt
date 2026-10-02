package server

import (
	"errors"
	"net/http"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func (s *Server) handleBrowseThreads(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	o := store.BrowseOpts{Source: q.Get("source"), Order: q.Get("order")}
	var err error
	o.From, o.To, o.Person = q.Get("from"), q.Get("to"), q.Get("person")
	if o.MailboxID, o.Subject, o.HasAttachment, err = parseMailFilters(q); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if o.Since, err = parseDate(q.Get("since")); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if o.Until, err = parseDate(q.Get("until")); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if o.Limit, err = parseInt(q.Get("limit"), 50); err != nil {
		writeErr(w, 400, "invalid limit")
		return
	}
	if o.Offset, err = parseInt(q.Get("offset"), 0); err != nil {
		writeErr(w, 400, "invalid offset")
		return
	}
	if err := o.Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	groups, err := s.read.BrowseThreads(r.Context(), o)
	if errors.Is(err, store.ErrMailboxSource) {
		writeErr(w, 400, err.Error())
		return
	}
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, groups)
}
