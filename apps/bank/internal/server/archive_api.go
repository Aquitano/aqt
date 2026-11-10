package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// registerArchiveAPI describes the routes over messages and their sources.
func (s *Server) registerArchiveAPI(api huma.API) {
	huma.Register(api, httpapi.Operation{ID: "searchMessages", Method: http.MethodGet, Path: "/v1/search", Tag: "messages",
		Summary: "Search messages by their text, ranked by relevance",
		Description: "Searches subject, body, sender, recipients and the text read from attachments. By default any " +
			"word may match and one typo per word is tolerated. For media, files and files on disks as well, use " +
			"the combined search.",
	}.For(api), s.search)
	huma.Register(api, httpapi.Operation{ID: "listMailboxes", Method: http.MethodGet, Path: "/v1/mailboxes", Tag: "messages",
		Summary: "List the mail folders a source was seen with",
	}.For(api), s.mailboxes)
	huma.Register(api, httpapi.Operation{ID: "getStats", Method: http.MethodGet, Path: "/v1/stats", Tag: "messages",
		Summary: "Count messages per source, with their date range and freshness",
	}.For(api), s.stats)
}

type searchInput struct {
	Q             string `query:"q" required:"true" minLength:"1" doc:"Words to find."`
	Source        string `query:"source" doc:"Only this source, such as gmail or whatsapp."`
	From          string `query:"from" doc:"Sender contains this, ignoring case."`
	To            string `query:"to" doc:"A recipient contains this, ignoring case."`
	Person        string `query:"person" doc:"Sent or received by this contact, by name."`
	Subject       string `query:"subject" doc:"Subject contains this, ignoring case."`
	Match         string `query:"match" enum:"any,all,phrase" doc:"any word (the default), every word, or the words adjacent and in order."`
	Fuzzy         int    `query:"fuzzy" default:"1" minimum:"0" maximum:"2" doc:"Typos tolerated per word."`
	Limit         int    `query:"limit" default:"20" minimum:"1" maximum:"500"`
	Offset        int    `query:"offset" default:"0" minimum:"0" maximum:"10000" doc:"Past 10000, narrow the query instead."`
	Since         string `query:"since" format:"date" doc:"Sent on or after this day, YYYY-MM-DD."`
	Until         string `query:"until" format:"date" doc:"Sent before this day, YYYY-MM-DD."`
	MailboxID     int64  `query:"mailbox_id" minimum:"1" doc:"Only this mail folder. Needs source."`
	HasAttachment string `query:"has_attachment" enum:"true,false" doc:"Only messages with, or without, attachments."`
}

func (s *Server) search(ctx context.Context, in *searchInput) (*httpapi.Body[[]store.Message], error) {
	o := store.SearchOpts{Source: in.Source, From: in.From, To: in.To, Person: in.Person, Subject: in.Subject,
		Match: in.Match, Fuzzy: in.Fuzzy, Limit: in.Limit, Offset: in.Offset, MailboxID: in.MailboxID}
	if in.MailboxID != 0 && in.Source == "" {
		return nil, httpapi.Invalid.New("mailbox_id requires a source")
	}
	if in.HasAttachment != "" {
		has := in.HasAttachment == "true"
		o.HasAttachment = &has
	}
	var err error
	if o.Since, err = parseDate(in.Since); err != nil {
		return nil, invalid(err)
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, invalid(err)
	}
	// Checked here as well as in the store, so a bad request is told what is
	// wrong with it, not answered with a database error.
	if err := o.ValidateQuery(in.Q); err != nil {
		return nil, invalid(err)
	}
	found, err := s.read.Search(ctx, in.Q, o)
	if _, noContact := errors.AsType[*store.ErrNoContact](err); noContact || errors.Is(err, store.ErrMailboxSource) {
		return nil, invalid(err)
	}
	return list(found, err)
}

type mailboxesInput struct {
	Source string `query:"source" doc:"The mail source, such as gmail or proton."`
}

func (s *Server) mailboxes(ctx context.Context, in *mailboxesInput) (*httpapi.Body[[]store.Mailbox], error) {
	if err := archive.ValidSource(in.Source); err != nil {
		return nil, invalid(err)
	}
	return list(s.read.ListMailboxes(ctx, in.Source))
}

func (s *Server) stats(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.SourceStats], error) {
	return list(s.read.Stats(ctx))
}
