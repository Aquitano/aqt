package server

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var (
	ListMailboxes = httpapi.Op[MailboxesInput, []store.Mailbox]{Operation: httpapi.Operation{ID: "listMailboxes", Method: http.MethodGet, Path: "/v1/mailboxes", Tag: "messages",
		Summary: "List the mail folders a source was seen with",
	}}
	GetStats = httpapi.Op[struct{}, []store.SourceStats]{Operation: httpapi.Operation{ID: "getStats", Method: http.MethodGet, Path: "/v1/stats", Tag: "messages",
		Summary: "Count messages per source, with their date range and freshness",
		Description: "One row per source. Before concluding that the archive lacks something, read the source's " +
			"note, the owner's account of what it holds, and whether it is stale.",
		Tool: true,
	}}
)

// registerArchiveAPI serves the routes over message sources.
func (s *Server) registerArchiveAPI(api huma.API) {
	httpapi.Register(api, ListMailboxes, s.mailboxes)
	httpapi.Register(api, GetStats, s.stats)
}

type MailboxesInput struct {
	Source string `query:"source" doc:"The mail source, such as gmail or proton."`
}

func (s *Server) mailboxes(ctx context.Context, in *MailboxesInput) (*httpapi.Body[[]store.Mailbox], error) {
	if err := ingest.ValidSource(in.Source); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return list(s.read.ListMailboxes(ctx, in.Source))
}

func (s *Server) stats(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.SourceStats], error) {
	return list(s.read.Stats(ctx))
}
