package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	atticapi "github.com/aquitano/aqt/apps/bank/internal/attic/api"
	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

const apiDescription = `bank is one person's archive: messages (mail, chats, AI conversations), a media
library with what was watched, listened to and read, files, published notes, and a
catalogue of the files on disks that come and go, below /v1/disk.

GET /v1/search searches all of it at once; kind narrows the search to one kind of
record. Every record is cited by one ref, kind:value: msg:<16 hex> for a message,
content:<16 to 64 hex> for bytes, and the ID for a library record, such as
item:<32 hex>. GET /v1/refs/{ref} says what any of them names.

A token reads, or reads and writes. An operation that changes the archive names the
write role in its security requirement, and answers Forbidden to a read token.

Lists and searches take limit, 100 by default and at most 500, and those that page by
position take offset, at most 10000. Every failure is JSON with a _tag.`

// registerAPI adds every operation to mux. Their document is generated from
// the Go types, and their failures carry a _tag.
func (s *Server) registerAPI(mux *http.ServeMux) huma.API {
	api := humago.New(mux, httpapi.Config("bank", apiDescription, mintCommand))
	api.UseMiddleware(httpapi.RequireToken(api, Tokens(s.dataDir), mintCommand))
	s.registerSearchAPI(api)
	s.registerArchiveAPI(api)
	s.registerMessagesAPI(api)
	s.registerContactsAPI(api)
	s.registerAttachmentsAPI(api)
	s.registerLibraryAPI(api)
	s.registerUploadsAPI(api)
	huma.Register(api, httpapi.Operation{ID: "getTimeline", Method: http.MethodGet, Path: "/v1/timeline", Tag: "timeline",
		Summary: "List what happened between two days, across messages, activity and files",
		Description: "Messages by when they were sent, activity (watching, listening, reading) by when it happened, " +
			"and files on disks by when they were last modified, merged oldest first. limit caps each group on " +
			"its own; truncated names the groups that reached it.",
	}.For(api), s.timeline)
	huma.Register(api, httpapi.Operation{ID: "resolveRef", Method: http.MethodGet, Path: "/v1/refs/{ref}", Tag: "refs",
		Summary: "Say what a cited ref names, whichever store holds it",
		Description: "Takes msg:<16 hex> for a message, a library ID such as item:<32 hex> or file:<32 hex>, or " +
			"content:<16 to 64 hex> for bytes. The answer names the record, the route that returns it in full, " +
			"and where the same bytes are: a message attachment's or library file's copies on disks, and for " +
			"bytes, the messages and library files that hold them as well as the places on disks.",
		Errors: []httpapi.Kind{httpapi.NotFound, atticapi.AmbiguousRef},
	}.For(api), s.resolve)
	s.catalogue.Register(api)
	httpapi.Finish(api)
	return api
}

// internal answers for a failure inside the server. The caller learns only
// that it happened; the log has the reason.
func internal(err error) error {
	slog.Error("HTTP request failed", "error", err)
	return httpapi.Internal.New(http.StatusText(http.StatusInternalServerError))
}

// failure is the documented answer for err. An error reaches the caller as
// itself only when its type or a sentinel says what it is; anything else is
// the server's failure, whatever its message.
func failure(err error) error {
	if e, ok := errors.AsType[*httpapi.Error](err); ok {
		return e
	}
	if retired, ok := errors.AsType[*store.RetiredError](err); ok {
		return errRetired.New(retired.Error()).With("retired", retired.Retired)
	}
	if ambiguous, ok := errors.AsType[*atticstore.AmbiguousRefError](err); ok {
		return atticapi.Ambiguous(ambiguous)
	}
	if conflict, ok := errors.AsType[*store.MailThreadConflictError](err); ok {
		return mailThreadConflict(conflict)
	}
	if taken, ok := errors.AsType[*store.ErrConflict](err); ok {
		return errAliasTaken.New(taken.Error()).With("alias", taken.Alias).With("owner", taken.Owner)
	}
	_, noContact := errors.AsType[*store.ErrNoContact](err)
	_, badQuery := errors.AsType[*store.BadQueryError](err)
	_, ambiguousThread := errors.AsType[*store.AmbiguousThreadError](err)
	switch {
	case errors.Is(err, library.ErrConflict):
		return errRevisionConflict.New("This record changed. Reload it before saving again.").With("code", "library_revision_conflict")
	case errors.Is(err, store.ErrNotFound), errors.Is(err, atticstore.ErrNotFound), errors.Is(err, catalog.ErrNoRecord):
		return httpapi.NotFound.New(err.Error())
	case noContact, badQuery, ambiguousThread, errors.Is(err, fail.ErrInvalid), errors.Is(err, library.ErrInvalid),
		errors.Is(err, library.ErrReadOnly), errors.Is(err, catalog.ErrFilters), errors.Is(err, store.ErrMailboxSource):
		return httpapi.Invalid.New(err.Error())
	}
	return internal(err)
}

func reply[T any](v T, err error) (*httpapi.Body[T], error) {
	if err != nil {
		return nil, failure(err)
	}
	return &httpapi.Body[T]{Body: v}, nil
}

// list is reply for a list: nothing found is [], where a nil slice would be null.
func list[T any](v []T, err error) (*httpapi.Body[[]T], error) {
	if v == nil {
		v = []T{}
	}
	return reply(v, err)
}

// Spec is the OpenAPI document bank serve answers with, built without a database.
func Spec() ([]byte, error) {
	return json.MarshalIndent((&Server{catalogue: attic.New(nil, "")}).registerAPI(http.NewServeMux()).OpenAPI(), "", "  ")
}

type resolveInput struct {
	Ref ref.Ref `path:"ref" doc:"The ref as cited, such as msg:<16 hex>."`
}

func (s *Server) resolve(ctx context.Context, in *resolveInput) (*httpapi.Body[catalog.Resolved], error) {
	return reply(catalog.Resolve(ctx, s.db, s.catalogue, in.Ref))
}

type timelineInput struct {
	Since string   `query:"since" required:"true" format:"date" doc:"First day, as YYYY-MM-DD in the server's time zone."`
	Until string   `query:"until" format:"date" doc:"The day after the last day. Default: the day after since."`
	Group []string `query:"group" enum:"message,activity,file" doc:"Only these groups. Default: all three."`
	httpapi.PageSize
}

func (s *Server) timeline(ctx context.Context, in *timelineInput) (*httpapi.Body[catalog.Timeline], error) {
	since, err := time.ParseInLocation(time.DateOnly, in.Since, time.Local)
	if err != nil {
		return nil, httpapi.Invalid.New("since is not a YYYY-MM-DD date")
	}
	until := since.AddDate(0, 0, 1)
	if in.Until != "" {
		if until, err = time.ParseInLocation(time.DateOnly, in.Until, time.Local); err != nil || !until.After(since) {
			return nil, httpapi.Invalid.New("until is a YYYY-MM-DD date after since")
		}
	}
	return reply(catalog.BuildTimeline(ctx, s.db, s.catalogue, catalog.TimelineOptions{Since: since, Until: until, Groups: in.Group, Limit: in.Limit}))
}
