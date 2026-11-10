package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var errAliasTaken = httpapi.Kind{Tag: "AliasTaken", Status: http.StatusConflict,
	Doc: "Another contact already has the alias; message names that contact."}

// maxContactImport bounds one import. A contact book is names and handles;
// anything past this is not one.
const maxContactImport = 8 << 20

// registerContactsAPI describes the routes over contacts and their aliases.
// Contacts are managed over HTTP as well as read: the deployed shape puts the
// database on a headless VPS, so a laptop that could only read them could
// never build the contact book in the first place.
func (s *Server) registerContactsAPI(api huma.API) {
	huma.Register(api, httpapi.Operation{ID: "listContacts", Method: http.MethodGet, Path: "/v1/contacts", Tag: "contacts",
		Summary: "List every contact with its aliases",
	}.For(api), s.contactList)
	huma.Register(api, httpapi.Operation{ID: "createContact", Method: http.MethodPost, Path: "/v1/contacts", Tag: "contacts",
		Summary:     "Create a contact without aliases",
		Description: "A name that is empty or already taken is an InvalidRequest.",
	}.For(api), s.contactCreate)
	importContacts := httpapi.Operation{ID: "importContacts", Method: http.MethodPost, Path: "/v1/contacts/import", Tag: "contacts",
		Summary: "Create or extend several contacts at once",
		Description: "An existing contact is kept and gains the aliases that are new. A conflict does not fail the " +
			"request: each entry's result lists its own errors, and the rest is applied.",
	}.For(api)
	importContacts.MaxBodyBytes = maxContactImport
	huma.Register(api, importContacts, s.contactImport)
	huma.Register(api, httpapi.Operation{ID: "suggestContacts", Method: http.MethodGet, Path: "/v1/contacts/suggest", Tag: "contacts",
		Summary: "List the identities no contact claims yet, the ones with most messages first",
	}.For(api), s.contactSuggest)
	huma.Register(api, httpapi.Operation{ID: "getContact", Method: http.MethodGet, Path: "/v1/contacts/{name}", Tag: "contacts",
		Summary: "Get one contact with its aliases and its message count per source",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.contactShow)
	huma.Register(api, httpapi.Operation{ID: "deleteContact", Method: http.MethodDelete, Path: "/v1/contacts/{name}", Tag: "contacts",
		Summary: "Delete a contact and its aliases, leaving its messages in place",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.contactDelete)
	huma.Register(api, httpapi.Operation{ID: "listContactMessages", Method: http.MethodGet, Path: "/v1/contacts/{name}/messages", Tag: "contacts",
		Summary: "List the messages a contact sent or received, across every source, newest first",
		Description: "Page with before, the id of the last message of the previous page, or with offset, " +
			"and not with both.",
		Errors: []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.contactMessages)
	huma.Register(api, httpapi.Operation{ID: "addContactAlias", Method: http.MethodPost, Path: "/v1/contacts/{name}/aliases", Tag: "contacts",
		Summary: "Attach an identity, such as an address or a handle, to a contact",
		Errors:  []httpapi.Kind{httpapi.NotFound, errAliasTaken},
	}.For(api), s.aliasAdd)
	huma.Register(api, httpapi.Operation{ID: "removeContactAlias", Method: http.MethodDelete, Path: "/v1/contacts/{name}/aliases", Tag: "contacts",
		Summary:     "Detach an identity from a contact",
		Description: "The alias is named in the query string. An alias the contact does not have is an InvalidRequest.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.aliasRemove)
}

// contactFailure sorts a store error the way the untyped routes did: an
// unknown contact is 404, a failing database or disk is the server's fault,
// and whatever is left is input the store refused.
func contactFailure(name string, err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return httpapi.NotFound.New("no contact " + name)
	case fail.IsOp(err):
		return internal(err)
	default:
		return invalid(err)
	}
}

type contactInput struct {
	Name string `path:"name" doc:"The contact's name."`
}

func (s *Server) contactList(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.Contact], error) {
	return list(s.read.ListContacts(ctx))
}

func (s *Server) contactShow(ctx context.Context, in *contactInput) (*httpapi.Body[store.ContactDetail], error) {
	c, err := s.read.GetContact(ctx, in.Name)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no contact " + in.Name)
	}
	if err != nil {
		return nil, internal(err)
	}
	counts, err := s.read.ContactSourceCounts(ctx, c.ID)
	return reply(store.ContactDetail{Contact: c, Sources: counts}, err)
}

type contactMessagesInput struct {
	Name   string `path:"name" doc:"The contact's name."`
	Source string `query:"source" doc:"Only this source, such as gmail or whatsapp."`
	Since  string `query:"since" format:"date" doc:"Sent on or after this day, YYYY-MM-DD."`
	Until  string `query:"until" format:"date" doc:"Sent before this day, YYYY-MM-DD."`
	Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"500"`
	Offset int    `query:"offset" default:"0" minimum:"0" maximum:"10000" doc:"Past 10000, narrow with source or since instead."`
	Before int64  `query:"before" minimum:"1" doc:"Only messages older than the message with this id, which must be one of the contact's."`
}

func (s *Server) contactMessages(ctx context.Context, in *contactMessagesInput) (*httpapi.Body[[]store.MessageDetail], error) {
	o := store.ContactMessagesOpts{Source: in.Source, Limit: in.Limit, Offset: in.Offset, Before: in.Before}
	var err error
	if o.Since, err = parseDate(in.Since); err != nil {
		return nil, invalid(err)
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, invalid(err)
	}
	msgs, err := s.read.ContactMessages(ctx, in.Name, o)
	if err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return list(msgs, nil)
}

type contactSuggestInput struct {
	Limit int `query:"limit" default:"20" minimum:"1" maximum:"500"`
}

func (s *Server) contactSuggest(ctx context.Context, in *contactSuggestInput) (*httpapi.Body[[]store.IdentitySuggestion], error) {
	out, err := s.read.SuggestIdentities(ctx, in.Limit)
	if err != nil {
		return nil, contactFailure("", err)
	}
	return list(out, nil)
}

type contactCreateInput struct {
	Body struct {
		Name string `json:"name"`
		Note string `json:"note,omitempty"`
	}
}

func (s *Server) contactCreate(ctx context.Context, in *contactCreateInput) (*httpapi.Body[store.Contact], error) {
	c, err := s.db.CreateContact(ctx, in.Body.Name, in.Body.Note)
	if err != nil {
		return nil, contactFailure(in.Body.Name, err)
	}
	return &httpapi.Body[store.Contact]{Body: c}, nil
}

type contactImportInput struct {
	Body []store.ContactImport
}

func (s *Server) contactImport(ctx context.Context, in *contactImportInput) (*httpapi.Body[[]store.ContactImportResult], error) {
	res, err := s.db.ImportContacts(ctx, in.Body)
	if err != nil {
		return nil, contactFailure("", err)
	}
	return list(res, nil)
}

type contactDeleted struct {
	Deleted bool `json:"deleted"`
}

func (s *Server) contactDelete(ctx context.Context, in *contactInput) (*httpapi.Body[contactDeleted], error) {
	if err := s.db.DeleteContact(ctx, in.Name); err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[contactDeleted]{Body: contactDeleted{Deleted: true}}, nil
}

type aliasAddInput struct {
	Name string `path:"name" doc:"The contact's name."`
	Body struct {
		Source string `json:"source,omitempty" doc:"The one source the alias counts in. Empty: every source."`
		Value  string `json:"value" doc:"The identity as the source writes it, such as an address or a display name."`
	}
}

func (s *Server) aliasAdd(ctx context.Context, in *aliasAddInput) (*httpapi.Body[store.ContactAlias], error) {
	a, err := s.db.AddAlias(ctx, in.Name, in.Body.Source, in.Body.Value)
	if _, taken := errors.AsType[*store.ErrConflict](err); taken {
		return nil, errAliasTaken.New(err.Error())
	}
	if err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[store.ContactAlias]{Body: a}, nil
}

type aliasRemoveInput struct {
	Name   string `path:"name" doc:"The contact's name."`
	Source string `query:"source" doc:"The source the alias is scoped to. Empty: the alias that counts in every source."`
	Value  string `query:"value" doc:"The alias to remove."`
}

type aliasRemoved struct {
	Removed bool `json:"removed"`
}

func (s *Server) aliasRemove(ctx context.Context, in *aliasRemoveInput) (*httpapi.Body[aliasRemoved], error) {
	if err := s.db.RemoveAlias(ctx, in.Name, in.Source, in.Value); err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[aliasRemoved]{Body: aliasRemoved{Removed: true}}, nil
}
