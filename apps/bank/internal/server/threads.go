package server

import (
	"net/http"

	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func (s *Server) handleBrowseThreads(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	o := store.BrowseOpts{Source: q.Get("source"), Order: q.Get("order")}
	var err error
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
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, groups)
}
