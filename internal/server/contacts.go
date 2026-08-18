package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/aquitano/aqt-bank/internal/store"
)

// Contacts are managed over HTTP as well as read: the deployed shape puts the
// database on a headless VPS, so a laptop that could only read them could
// never build the contact book in the first place.

func (s *Server) handleContactList(w http.ResponseWriter, r *http.Request) {
	contacts, err := s.read.ListContacts(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, contacts)
}

// ContactDetail is a contact plus where its messages actually are — the answer
// to "did this alias catch anything?".
type ContactDetail struct {
	store.Contact
	Sources []store.ContactSourceCount `json:"sources"`
}

func (s *Server) handleContactShow(w http.ResponseWriter, r *http.Request) {
	c, err := s.read.GetContact(r.Context(), r.PathValue("name"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no contact "+r.PathValue("name"))
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	counts, err := s.read.ContactSourceCounts(r.Context(), c.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ContactDetail{Contact: c, Sources: counts})
}

func (s *Server) handleContactMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	o := store.ContactMessagesOpts{Source: q.Get("source")}
	var err error
	if o.Offset, err = parseInt(q.Get("offset"), 0); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid offset")
		return
	}
	if o.Since, err = parseDate(q.Get("since")); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if o.Until, err = parseDate(q.Get("until")); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if o.Limit, err = parseInt(q.Get("limit"), 0); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	msgs, err := s.read.ContactMessages(r.Context(), r.PathValue("name"), o)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, msgs)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "no contact "+r.PathValue("name"))
	default:
		writeCause(w, err)
	}
}

func (s *Server) handleContactSuggest(w http.ResponseWriter, r *http.Request) {
	limit, err := parseInt(r.URL.Query().Get("limit"), 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid limit")
		return
	}
	out, err := s.read.SuggestIdentities(r.Context(), limit)
	if err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleContactCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Note string `json:"note"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	c, err := s.db.CreateContact(r.Context(), body.Name, body.Note)
	if err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleContactDelete(w http.ResponseWriter, r *http.Request) {
	err := s.db.DeleteContact(r.Context(), r.PathValue("name"))
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "no contact "+r.PathValue("name"))
		return
	}
	if err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleAliasAdd(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Source string `json:"source"`
		Value  string `json:"value"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a, err := s.db.AddAlias(r.Context(), r.PathValue("name"), body.Source, body.Value)
	var conflict *store.ErrConflict
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, a)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "no contact "+r.PathValue("name"))
	case errors.As(err, &conflict):
		// The request is well formed; the archive's current state refuses it.
		writeErr(w, http.StatusConflict, err.Error())
	default:
		writeCause(w, err)
	}
}

func (s *Server) handleAliasRemove(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	err := s.db.RemoveAlias(r.Context(), r.PathValue("name"), q.Get("source"), q.Get("value"))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]bool{"removed": true})
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "no contact "+r.PathValue("name"))
	default:
		writeCause(w, err)
	}
}

// decodeJSON reads a small request body, refusing unknown fields so a typo in
// a field name is an error rather than a silently ignored value.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid JSON body: " + strings.TrimSpace(err.Error()))
	}
	return nil
}
