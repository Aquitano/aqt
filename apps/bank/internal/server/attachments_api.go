package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// registerAttachmentsAPI describes the routes over attachments and the text read from them.
func (s *Server) registerAttachmentsAPI(api huma.API) {
	huma.Register(api, httpapi.Operation{ID: "searchAttachments", Method: http.MethodGet, Path: "/v1/attachment-library", Tag: "attachments",
		Summary: "Search the files attached to messages, newest first",
		Description: "One entry per distinct content, however many messages carry it. query searches the filename and " +
			"the text read from the file. q and text are plain substring filters, and text adds a snippet around " +
			"the match.",
	}.For(api), s.searchAttachments)
	huma.Register(api, httpapi.Operation{ID: "listAttachmentMessages", Method: http.MethodGet, Path: "/v1/attachments/{sha256}/messages", Tag: "attachments",
		Summary: "List the messages that carry a file, newest first",
	}.For(api), s.attachmentMessages)
	huma.Register(api, httpapi.Operation{ID: "listAttachments", Method: http.MethodGet, Path: "/v1/attachments", Tag: "attachments",
		Summary: "List distinct attachment content with the state of its text, largest first",
		Description: "This is the work list for reading text out of files somewhere other than the server: fetch the " +
			"bytes from /v1/blobs/{sha256}, then store the result with PUT /v1/attachments/{sha256}/text.",
	}.For(api), s.attachments)
	huma.Register(api, httpapi.Operation{ID: "getAttachmentStats", Method: http.MethodGet, Path: "/v1/attachments/stats", Tag: "attachments",
		Summary: "Count attachment content, bytes and text characters per text status",
	}.For(api), s.attachmentStats)
	huma.Register(api, httpapi.Operation{ID: "refreshAttachmentText", Method: http.MethodPost, Path: "/v1/attachments/refresh", Tag: "attachments",
		Summary: "Copy stored attachment text onto the messages that carry it, so search finds it",
		Description: "Call it once after storing or deleting text, not after every file: without since it sweeps " +
			"every message.",
	}.For(api), s.refreshAttachmentText)
	huma.Register(api, httpapi.Operation{ID: "getAttachmentText", Method: http.MethodGet, Path: "/v1/attachments/{sha256}/text", Tag: "attachments",
		Summary: "Return the text read from a file",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.attachmentText)
	huma.Register(api, httpapi.Operation{ID: "deleteAttachmentText", Method: http.MethodDelete, Path: "/v1/attachments/{sha256}/text", Tag: "attachments",
		Summary:     "Drop the text stored for a file, which makes the file pending again",
		Description: "Messages keep the old text in search until the next refresh.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.deleteAttachmentText)
}

type digestInput struct {
	SHA256 string `path:"sha256" pattern:"^[0-9a-f]{64}$" doc:"The content's SHA-256, as 64 lowercase hex characters."`
}

type searchAttachmentsInput struct {
	Query  string `query:"query" doc:"Words to find in the filename or in the text read from the file. At most 4096 bytes."`
	Match  string `query:"match" enum:"any,all,phrase" doc:"For query: any word (the default), every word, or the words adjacent and in order."`
	Source string `query:"source" doc:"Only attachments of messages from this source, such as gmail or whatsapp."`
	Q      string `query:"q" doc:"Filename contains this, ignoring case."`
	Text   string `query:"text" doc:"Text read from the file contains this, ignoring case."`
	Type   string `query:"type" doc:"A file extension such as pdf, a media type such as application/pdf, or its first half such as image."`
	Person string `query:"person" doc:"Sent or received by this contact, by name."`
	Since  string `query:"since" format:"date" doc:"Carried by a message sent on or after this day, YYYY-MM-DD."`
	Until  string `query:"until" format:"date" doc:"Carried by a message sent before this day, YYYY-MM-DD."`
	Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
	Offset int    `query:"offset" default:"0" minimum:"0" maximum:"10000"`
}

func (s *Server) searchAttachments(ctx context.Context, in *searchAttachmentsInput) (*httpapi.Body[[]store.LibraryFile], error) {
	o := store.AttachmentFilter{Query: in.Query, Source: in.Source, Match: in.Match, Filename: in.Q, Text: in.Text,
		FileType: in.Type, Person: in.Person, Limit: in.Limit, Offset: in.Offset}
	if err := (library.ListOptions{Query: o.Query, Match: o.Match}).Validate(); err != nil {
		return nil, invalid(err)
	}
	var err error
	if o.Since, err = parseDate(in.Since); err != nil {
		return nil, httpapi.Invalid.New("invalid since")
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, httpapi.Invalid.New("invalid until")
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Since.Before(o.Until) {
		return nil, httpapi.Invalid.New("until must be after since")
	}
	files, err := s.db.AttachmentLibrary(ctx, o)
	if _, noContact := errors.AsType[*store.ErrNoContact](err); noContact {
		return nil, invalid(err)
	}
	return list(files, err)
}

type attachmentMessagesInput struct {
	SHA256 string `path:"sha256" pattern:"^[0-9a-f]{64}$" doc:"The content's SHA-256, as 64 lowercase hex characters."`
	Limit  int    `query:"limit" default:"50" minimum:"1" maximum:"100"`
	Offset int    `query:"offset" default:"0" minimum:"0" maximum:"10000"`
}

func (s *Server) attachmentMessages(ctx context.Context, in *attachmentMessagesInput) (*httpapi.Body[[]store.Message], error) {
	return list(s.db.AttachmentMessages(ctx, in.SHA256, in.Offset, in.Limit))
}

type attachmentsInput struct {
	Status []string `query:"status" doc:"Only these text statuses, separated by commas: pending (never tried), ok, empty, needs_ocr, unsupported, too_big, failed or manual. Default: all."`
	Source string   `query:"source" doc:"Only content from this source."`
	Limit  int      `query:"limit" doc:"Maximum entries. 5000 is both the default and the most one request returns."`
}

func (s *Server) attachments(ctx context.Context, in *attachmentsInput) (*httpapi.Body[[]store.BlobRef], error) {
	return list(s.db.ListBlobs(ctx, store.ListBlobsOpts{Statuses: in.Status, Source: in.Source, Limit: in.Limit}))
}

func (s *Server) attachmentStats(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.ExtractionStat], error) {
	return list(s.db.ExtractionStats(ctx))
}

type refreshAttachmentTextInput struct {
	Since string `query:"since" format:"date-time" doc:"Only messages with an attachment stored or read at or after this RFC 3339 time. Default: every message."`
}

type attachmentTextRefreshed struct {
	MessagesReindexed int64 `json:"messages_reindexed" doc:"Messages whose searchable attachment text changed."`
}

func (s *Server) refreshAttachmentText(ctx context.Context, in *refreshAttachmentTextInput) (*httpapi.Body[attachmentTextRefreshed], error) {
	var since time.Time
	if in.Since != "" {
		var err error
		if since, err = time.Parse(time.RFC3339Nano, in.Since); err != nil {
			return nil, httpapi.Invalid.New("since must be an RFC 3339 time")
		}
	}
	n, err := s.db.RefreshAttachmentText(ctx, since)
	return reply(attachmentTextRefreshed{MessagesReindexed: n}, err)
}

func (s *Server) attachmentText(ctx context.Context, in *digestInput) (*httpapi.Body[store.BlobText], error) {
	text, err := s.db.GetBlobText(ctx, in.SHA256)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no extracted text for " + in.SHA256)
	}
	return reply(text, err)
}

type attachmentTextDeleted struct {
	SHA256 string `json:"sha256"`
	Status string `json:"status" enum:"deleted"`
}

func (s *Server) deleteAttachmentText(ctx context.Context, in *digestInput) (*httpapi.Body[attachmentTextDeleted], error) {
	err := s.db.DeleteBlobText(ctx, in.SHA256)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no extracted text for " + in.SHA256)
	}
	return reply(attachmentTextDeleted{SHA256: in.SHA256, Status: "deleted"}, err)
}
