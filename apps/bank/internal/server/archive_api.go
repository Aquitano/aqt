package server

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// registerArchiveAPI describes the routes over message sources.
func (s *Server) registerArchiveAPI(api huma.API) {
	huma.Register(api, httpapi.Operation{ID: "listMailboxes", Method: http.MethodGet, Path: "/v1/mailboxes", Tag: "messages",
		Summary: "List the mail folders a source was seen with",
	}.For(api), s.mailboxes)
	huma.Register(api, httpapi.Operation{ID: "getStats", Method: http.MethodGet, Path: "/v1/stats", Tag: "messages",
		Summary: "Count messages per source, with their date range and freshness",
	}.For(api), s.stats)
}

type mailboxesInput struct {
	Source string `query:"source" doc:"The mail source, such as gmail or proton."`
}

func (s *Server) mailboxes(ctx context.Context, in *mailboxesInput) (*httpapi.Body[[]store.Mailbox], error) {
	if err := archive.ValidSource(in.Source); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return list(s.read.ListMailboxes(ctx, in.Source))
}

func (s *Server) stats(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.SourceStats], error) {
	return list(s.read.Stats(ctx))
}
