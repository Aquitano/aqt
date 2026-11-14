package server

import (
	"context"
	"errors"
	"net/http"
	"reflect"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var errAliasTaken = httpapi.Kind{Tag: "AliasTaken", Status: http.StatusConflict,
	Doc:   "Another contact already has the alias. alias is its normalized form and owner the contact that has it.",
	Extra: map[string]reflect.Type{"alias": reflect.TypeFor[string](), "owner": reflect.TypeFor[string]()}}

// maxContactImport bounds one import. A contact book is names and handles;
// anything past this is not one.
const maxContactImport = 8 << 20

var (
	ListContacts = httpapi.Op[struct{}, []store.Contact]{Operation: httpapi.Operation{ID: "listContacts", Method: http.MethodGet, Path: "/v1/contacts", Tag: "contacts",
		Summary:     "List every contact with its aliases",
		Description: "A contact's name is what the person filter of search and listThreads takes; its aliases are the addresses and handles that filter matches.",
		Tool:        true,
	}}
	CreateContact = httpapi.Op[ContactCreateInput, store.Contact]{Operation: httpapi.Operation{ID: "createContact", Method: http.MethodPost, Path: "/v1/contacts", Tag: "contacts",
		Summary:     "Create a contact without aliases",
		Description: "A name that is empty or already taken is an InvalidRequest.",
		Writes:      true,
	}}
	ImportContacts = httpapi.Op[ContactImportInput, []store.ContactImportResult]{Operation: httpapi.Operation{ID: "importContacts", Method: http.MethodPost, Path: "/v1/contacts/import", Tag: "contacts",
		Summary: "Create or extend several contacts at once",
		Description: "An existing contact is kept and gains the aliases that are new. A conflict does not fail the " +
			"request: each entry's result lists its own errors, and the rest is applied.",
		Writes: true,
	}}
	SuggestContacts = httpapi.Op[ContactSuggestInput, []store.IdentitySuggestion]{Operation: httpapi.Operation{ID: "suggestContacts", Method: http.MethodGet, Path: "/v1/contacts/suggest", Tag: "contacts",
		Summary: "List the identities no contact claims yet, the ones with most messages first",
	}}
	GetContact = httpapi.Op[ContactInput, store.ContactDetail]{Operation: httpapi.Operation{ID: "getContact", Method: http.MethodGet, Path: "/v1/contacts/{name}", Tag: "contacts",
		Summary: "Get one contact with its aliases and its message count per source",
		Errors:  []httpapi.Kind{httpapi.NotFound},
		Tool:    true,
	}}
	DeleteContact = httpapi.Op[ContactInput, ContactDeleted]{Operation: httpapi.Operation{ID: "deleteContact", Method: http.MethodDelete, Path: "/v1/contacts/{name}", Tag: "contacts",
		Summary: "Delete a contact and its aliases, leaving its messages in place",
		Errors:  []httpapi.Kind{httpapi.NotFound},
		Writes:  true,
	}}
	SetSelfContact = httpapi.Op[ContactInput, store.Contact]{Operation: httpapi.Operation{ID: "setSelfContact", Method: http.MethodPut, Path: "/v1/contacts/{name}/self", Tag: "contacts",
		Summary:     "Mark a contact as the archive's owner",
		Description: "Browse leaves the owner's aliases out of a thread's members. A contact marked before loses the mark.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
		Writes:      true,
	}}
	ListContactMessages = httpapi.Op[ContactMessagesInput, []store.MessageDetail]{Operation: httpapi.Operation{ID: "listContactMessages", Method: http.MethodGet, Path: "/v1/contacts/{name}/messages", Tag: "contacts",
		Summary: "List the messages a contact sent or received, across every source, newest first",
		Description: "Page with before, the ref of the last message of the previous page, or with offset, " +
			"and not with both.",
		Errors: []httpapi.Kind{httpapi.NotFound},
	}}
	AddContactAlias = httpapi.Op[AliasAddInput, store.ContactAlias]{Operation: httpapi.Operation{ID: "addContactAlias", Method: http.MethodPost, Path: "/v1/contacts/{name}/aliases", Tag: "contacts",
		Summary: "Attach an identity, such as an address or a handle, to a contact",
		Errors:  []httpapi.Kind{httpapi.NotFound, errAliasTaken},
		Writes:  true,
	}}
	RemoveContactAlias = httpapi.Op[AliasRemoveInput, AliasRemoved]{Operation: httpapi.Operation{ID: "removeContactAlias", Method: http.MethodDelete, Path: "/v1/contacts/{name}/aliases", Tag: "contacts",
		Summary:     "Detach an identity from a contact",
		Description: "The alias is named in the query string. An alias the contact does not have is an InvalidRequest.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
		Writes:      true,
	}}
)

// registerContactsAPI serves the routes over contacts and their aliases.
// Contacts are managed over HTTP as well as read: the deployed shape puts the
// database on a headless VPS, so a laptop that could only read them could
// never build the contact book in the first place.
func (s *Server) registerContactsAPI(api huma.API) {
	httpapi.Register(api, ListContacts, s.contactList)
	httpapi.Register(api, CreateContact, s.contactCreate)
	httpapi.Register(api, ImportContacts, s.contactImport, func(op *huma.Operation) {
		op.MaxBodyBytes, op.BodyReadTimeout = maxContactImport, bulkBodyReadTimeout
	})
	httpapi.Register(api, SuggestContacts, s.contactSuggest)
	httpapi.Register(api, GetContact, s.contactShow)
	httpapi.Register(api, DeleteContact, s.contactDelete)
	httpapi.Register(api, SetSelfContact, s.contactSelf)
	httpapi.Register(api, ListContactMessages, s.contactMessages)
	httpapi.Register(api, AddContactAlias, s.aliasAdd)
	httpapi.Register(api, RemoveContactAlias, s.aliasRemove)
}

// contactFailure names the contact when there is none, and otherwise is
// failure: input the store marked as invalid is the caller's, anything else
// the server's.
func contactFailure(name string, err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return httpapi.NotFound.New("no contact " + name)
	}
	return failure(err)
}

type ContactInput struct {
	Name string `path:"name" doc:"The contact's name."`
}

func (s *Server) contactList(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.Contact], error) {
	return list(s.read.ListContacts(ctx))
}

func (s *Server) contactShow(ctx context.Context, in *ContactInput) (*httpapi.Body[store.ContactDetail], error) {
	c, err := s.read.GetContact(ctx, in.Name)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no contact " + in.Name)
	}
	if err != nil {
		return nil, failure(err)
	}
	counts, err := s.read.ContactSourceCounts(ctx, c.ID)
	return reply(store.ContactDetail{Contact: c, Sources: counts}, err)
}

type ContactMessagesInput struct {
	Name   string      `path:"name" doc:"The contact's name."`
	Source string      `query:"source" doc:"Only this source, such as gmail or whatsapp."`
	Since  string      `query:"since" format:"date" doc:"Sent on or after this day, YYYY-MM-DD."`
	Until  string      `query:"until" format:"date" doc:"Sent before this day, YYYY-MM-DD."`
	Before ref.Message `query:"before" doc:"Only messages older than the message with this ref, which must be one of the contact's."`
	httpapi.Page
}

func (s *Server) contactMessages(ctx context.Context, in *ContactMessagesInput) (*httpapi.Body[[]store.MessageDetail], error) {
	o := store.ContactMessagesOpts{Source: in.Source, Limit: in.Limit, Offset: in.Offset, Before: in.Before}
	var err error
	if o.Since, err = parseDate(in.Since); err != nil {
		return nil, failure(err)
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, failure(err)
	}
	msgs, err := s.read.ContactMessages(ctx, in.Name, o)
	if err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return list(msgs, nil)
}

type ContactSuggestInput struct {
	httpapi.PageSize
}

func (s *Server) contactSuggest(ctx context.Context, in *ContactSuggestInput) (*httpapi.Body[[]store.IdentitySuggestion], error) {
	return list(s.read.SuggestIdentities(ctx, in.Limit))
}

type ContactCreateInput struct {
	Body ContactCreateInputBody
}

type ContactCreateInputBody struct {
	Name string `json:"name"`
	Note string `json:"note,omitempty"`
}

func (s *Server) contactCreate(ctx context.Context, in *ContactCreateInput) (*httpapi.Body[store.Contact], error) {
	c, err := s.db.CreateContact(ctx, in.Body.Name, in.Body.Note)
	if err != nil {
		return nil, contactFailure(in.Body.Name, err)
	}
	return &httpapi.Body[store.Contact]{Body: c}, nil
}

type ContactImportInput struct {
	Body []store.ContactImport
}

func (s *Server) contactImport(ctx context.Context, in *ContactImportInput) (*httpapi.Body[[]store.ContactImportResult], error) {
	return list(s.db.ImportContacts(ctx, in.Body))
}

type ContactDeleted struct {
	Deleted bool `json:"deleted"`
}

func (s *Server) contactDelete(ctx context.Context, in *ContactInput) (*httpapi.Body[ContactDeleted], error) {
	if err := s.db.DeleteContact(ctx, in.Name); err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[ContactDeleted]{Body: ContactDeleted{Deleted: true}}, nil
}

func (s *Server) contactSelf(ctx context.Context, in *ContactInput) (*httpapi.Body[store.Contact], error) {
	if err := s.db.SetSelf(ctx, in.Name); err != nil {
		return nil, contactFailure(in.Name, err)
	}
	c, err := s.db.GetContact(ctx, in.Name)
	if err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return reply(c, nil)
}

type AliasAddInput struct {
	Name string `path:"name" doc:"The contact's name."`
	Body AliasAddInputBody
}

type AliasAddInputBody struct {
	Source string `json:"source,omitempty" doc:"The one source the alias counts in. Empty: every source."`
	Value  string `json:"value" doc:"The identity as the source writes it, such as an address or a display name."`
}

func (s *Server) aliasAdd(ctx context.Context, in *AliasAddInput) (*httpapi.Body[store.ContactAlias], error) {
	a, err := s.db.AddAlias(ctx, in.Name, in.Body.Source, in.Body.Value)
	if err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[store.ContactAlias]{Body: a}, nil
}

type AliasRemoveInput struct {
	Name   string `path:"name" doc:"The contact's name."`
	Source string `query:"source" doc:"The source the alias is scoped to. Empty: the alias that counts in every source."`
	Value  string `query:"value" doc:"The alias to remove."`
}

type AliasRemoved struct {
	Removed bool `json:"removed"`
}

func (s *Server) aliasRemove(ctx context.Context, in *AliasRemoveInput) (*httpapi.Body[AliasRemoved], error) {
	if err := s.db.RemoveAlias(ctx, in.Name, in.Source, in.Value); err != nil {
		return nil, contactFailure(in.Name, err)
	}
	return &httpapi.Body[AliasRemoved]{Body: AliasRemoved{Removed: true}}, nil
}
