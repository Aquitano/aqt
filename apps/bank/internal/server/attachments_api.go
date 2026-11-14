package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/gabriel-vasile/mimetype"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/extraction"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/packages/go/extract"
)

var errUnpreviewable = httpapi.Kind{Tag: "Unpreviewable", Status: http.StatusUnsupportedMediaType,
	Doc: "The file is not a PDF, image, audio or video a browser shows inline. Read its text from getAttachmentText, or download it from getBlob."}

// maxTextUpload bounds what is read off the wire. What is storable is
// extract.MaxChars, which is smaller: reading past it is what lets an
// oversized body be refused with a message saying how far over it is, rather
// than as a truncated read.
const maxTextUpload = 8 << 20

var (
	SearchAttachments = httpapi.Op[SearchAttachmentsInput, []store.LibraryFile]{Operation: httpapi.Operation{ID: "searchAttachments", Method: http.MethodGet, Path: "/v1/attachment-library", Tag: "attachments",
		Summary: "Search the files attached to messages, newest first",
		Description: "One entry per distinct content, however many messages carry it. query searches the filename and " +
			"the text read from the file. q and text are plain substring filters, and text adds a snippet around " +
			"the match.",
	}}
	ListAttachmentMessages = httpapi.Op[AttachmentMessagesInput, []store.Message]{Operation: httpapi.Operation{ID: "listAttachmentMessages", Method: http.MethodGet, Path: "/v1/attachments/{blake3}/messages", Tag: "attachments",
		Summary: "List the messages that carry a file, newest first",
	}}
	ListAttachments = httpapi.Op[AttachmentsInput, []store.BlobRef]{Operation: httpapi.Operation{ID: "listAttachments", Method: http.MethodGet, Path: "/v1/attachments", Tag: "attachments",
		Summary: "List distinct attachment content with the state of its text, largest first",
		Description: "This is the work list for reading text out of files somewhere other than the server: fetch the " +
			"bytes from /v1/blobs/{blake3}, then store the result with PUT /v1/attachments/{blake3}/text. Content a " +
			"disk scan already read is not pending.",
	}}
	GetAttachmentStats = httpapi.Op[struct{}, []store.ExtractionStat]{Operation: httpapi.Operation{ID: "getAttachmentStats", Method: http.MethodGet, Path: "/v1/attachments/stats", Tag: "attachments",
		Summary: "Count attachment content, bytes and text characters per text status",
	}}
	GetAttachmentText = httpapi.Op[DigestInput, store.BlobText]{Operation: httpapi.Operation{ID: "getAttachmentText", Method: http.MethodGet, Path: "/v1/attachments/{blake3}/text", Tag: "attachments",
		Summary: "Return the text read from a file",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}}
	SetAttachmentText = httpapi.Op[SetAttachmentTextInput, AttachmentTextStored]{Operation: httpapi.Operation{ID: "setAttachmentText", Method: http.MethodPut, Path: "/v1/attachments/{blake3}/text", Tag: "attachments",
		Summary: "Store text read from a file somewhere else, such as a transcription",
		Description: "The body is the text. status defaults to manual, which no job overwrites. Text over " +
			"the 4 MiB a row holds is refused rather than cut. Messages carrying the file search the new text at once.",
		Errors: []httpapi.Kind{httpapi.NotFound},
		Writes: true,
	}}
	DeleteAttachmentText = httpapi.Op[DigestInput, AttachmentTextDeleted]{Operation: httpapi.Operation{ID: "deleteAttachmentText", Method: http.MethodDelete, Path: "/v1/attachments/{blake3}/text", Tag: "attachments",
		Summary:     "Drop the text stored for a file and queue it to be read again",
		Description: "Messages carrying the file stop finding the old text at once.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
		Writes:      true,
	}}
	PreviewAttachment = httpapi.StreamOp[DigestInput]{Operation: httpapi.Operation{ID: "previewAttachment", Method: http.MethodGet, Path: "/v1/attachments/{blake3}/preview", Tag: "attachments",
		Summary: "Show a PDF, image, audio or video attachment inline",
		Description: "Content-Type is detected from the bytes, and Range requests are answered, so a browser can " +
			"seek in audio and video. Other files are Unpreviewable.",
		Errors: []httpapi.Kind{httpapi.NotFound, errUnpreviewable},
	}}
	GetBlob = httpapi.StreamOp[DigestInput]{Operation: httpapi.Operation{ID: "getBlob", Method: http.MethodGet, Path: "/v1/blobs/{blake3}", Tag: "attachments",
		Summary: "Download stored bytes: an attachment or a library file",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}}
)

// registerAttachmentsAPI serves the routes over attachments, the text read
// from them and stored bytes. Attachment text is writable, not just readable,
// because the machine that can run an OCR model is rarely the VPS: a laptop
// lists what needs text, fetches the bytes, runs whatever it likes, and puts
// the result back.
func (s *Server) registerAttachmentsAPI(api huma.API) {
	httpapi.Register(api, SearchAttachments, s.searchAttachments)
	httpapi.Register(api, ListAttachmentMessages, s.attachmentMessages)
	httpapi.Register(api, ListAttachments, s.attachments)
	httpapi.Register(api, GetAttachmentStats, s.attachmentStats)
	httpapi.Register(api, GetAttachmentText, s.attachmentText)
	// An empty body is text too: a status such as needs_ocr carries none.
	httpapi.Register(api, SetAttachmentText, s.setAttachmentText, func(op *huma.Operation) {
		op.MaxBodyBytes = maxTextUpload
	}).RequestBody.Required = false
	httpapi.Register(api, DeleteAttachmentText, s.deleteAttachmentText)
	httpapi.RegisterStream(api, PreviewAttachment, s.attachmentPreview, bytesResponse("The file's bytes, inline."))
	httpapi.RegisterStream(api, GetBlob, s.blob, bytesResponse("The bytes."))
}

func bytesResponse(description string) func(*huma.Operation) {
	return func(op *huma.Operation) {
		op.Responses["200"] = &huma.Response{Description: description,
			Content: map[string]*huma.MediaType{"application/octet-stream": {Schema: &huma.Schema{Type: "string", Format: "binary"}}}}
	}
}

type DigestInput struct {
	BLAKE3 content.Digest `path:"blake3" pattern:"^[0-9a-f]{64}$" doc:"The content's BLAKE3 digest, as 64 lowercase hex characters."`
}

type SearchAttachmentsInput struct {
	Query  string `query:"query" doc:"Words to find in the filename or in the text read from the file. At most 4096 bytes."`
	Match  string `query:"match" enum:"any,all,phrase" doc:"For query: any word (the default), every word, or the words adjacent and in order."`
	Source string `query:"source" doc:"Only attachments of messages from this source, such as gmail or whatsapp."`
	Q      string `query:"q" doc:"Filename contains this, ignoring case."`
	Text   string `query:"text" doc:"Text read from the file contains this, ignoring case."`
	Type   string `query:"type" doc:"A file extension such as pdf, a media type such as application/pdf, or its first half such as image."`
	Person string `query:"person" doc:"Sent or received by this contact, by name."`
	Since  string `query:"since" format:"date" doc:"Carried by a message sent on or after this day, YYYY-MM-DD."`
	Until  string `query:"until" format:"date" doc:"Carried by a message sent before this day, YYYY-MM-DD."`
	httpapi.Page
}

func (s *Server) searchAttachments(ctx context.Context, in *SearchAttachmentsInput) (*httpapi.Body[[]store.LibraryFile], error) {
	o := store.AttachmentFilter{Query: in.Query, Source: in.Source, Match: in.Match, Filename: in.Q, Text: in.Text,
		FileType: in.Type, Person: in.Person, Limit: in.Limit, Offset: in.Offset}
	if err := (library.ListOptions{Query: o.Query, Match: o.Match}).Validate(); err != nil {
		return nil, failure(err)
	}
	var err error
	if o.Since, err = parseDate(in.Since); err != nil {
		return nil, failure(err)
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, failure(err)
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Since.Before(o.Until) {
		return nil, httpapi.Invalid.New("until must be after since")
	}
	return list(s.read.AttachmentLibrary(ctx, o))
}

type AttachmentMessagesInput struct {
	BLAKE3 content.Digest `path:"blake3" pattern:"^[0-9a-f]{64}$" doc:"The content's BLAKE3 digest, as 64 lowercase hex characters."`
	httpapi.Page
}

func (s *Server) attachmentMessages(ctx context.Context, in *AttachmentMessagesInput) (*httpapi.Body[[]store.Message], error) {
	return list(s.db.AttachmentMessages(ctx, in.BLAKE3, in.Offset, in.Limit))
}

type AttachmentsInput struct {
	Status []string `query:"status" doc:"Only these text statuses, separated by commas: pending (never tried), ok, truncated, empty, needs_ocr, unsupported, too_big, failed or manual. Default: all."`
	Source string   `query:"source" doc:"Only content from this source."`
	httpapi.PageSize
}

func (s *Server) attachments(ctx context.Context, in *AttachmentsInput) (*httpapi.Body[[]store.BlobRef], error) {
	if in.Source != "" {
		if err := ingest.ValidSource(in.Source); err != nil {
			return nil, httpapi.Invalid.New(err.Error())
		}
	}
	return list(s.db.ListBlobs(ctx, store.ListBlobsOpts{Statuses: in.Status, Source: in.Source, Limit: in.Limit}))
}

func (s *Server) attachmentStats(ctx context.Context, _ *struct{}) (*httpapi.Body[[]store.ExtractionStat], error) {
	return list(s.db.ExtractionStats(ctx))
}

func (s *Server) attachmentText(ctx context.Context, in *DigestInput) (*httpapi.Body[store.BlobText], error) {
	text, err := s.db.GetBlobText(ctx, in.BLAKE3)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no extracted text for " + in.BLAKE3.String())
	}
	return reply(text, err)
}

type SetAttachmentTextInput struct {
	BLAKE3    content.Digest `path:"blake3" pattern:"^[0-9a-f]{64}$" doc:"The content's BLAKE3 digest, as 64 lowercase hex characters."`
	Status    string         `query:"status" doc:"What the text is: manual (the default) for a transcription, or the outcome of an extraction run elsewhere, such as ok or needs_ocr."`
	Extractor string         `query:"extractor" doc:"What produced the text, such as a model's name."`
	RawBody   []byte         `contentType:"text/plain"`
}

type AttachmentTextStored struct {
	BLAKE3 content.Digest `json:"blake3"`
	Status string         `json:"status"`
}

func (s *Server) setAttachmentText(ctx context.Context, in *SetAttachmentTextInput) (*httpapi.Body[AttachmentTextStored], error) {
	status := in.Status
	if status == "" {
		status = string(extract.StatusManual)
	}
	// A status nothing recognizes strands the row: no default pass selects it
	// again, and the content looks read when it never was. Storing "pending"
	// is the same mistake spelled correctly — it means the absence of a row.
	if err := extraction.ValidStoredStatus(status); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	// Storing it would silently halve a transcription, which is the worst
	// place to lose text: nothing else can produce it again.
	if len(in.RawBody) > extract.MaxChars {
		return nil, httpapi.Invalid.New(fmt.Sprintf("text is %d bytes, over the %d a row holds", len(in.RawBody), extract.MaxChars))
	}
	// Text for a digest the archive never saw would be unreachable by any
	// message and invisible to every later refresh.
	known, err := s.db.KnownAttachment(ctx, in.BLAKE3)
	if err != nil {
		return nil, failure(err)
	}
	if !known {
		return nil, httpapi.NotFound.New("no attachment with blake3 " + in.BLAKE3.String())
	}
	err = s.db.PutBlobText(ctx, store.BlobText{BLAKE3: in.BLAKE3, Text: string(in.RawBody), Extractor: in.Extractor, Status: status})
	return reply(AttachmentTextStored{BLAKE3: in.BLAKE3, Status: status}, err)
}

type AttachmentTextDeleted struct {
	BLAKE3 content.Digest `json:"blake3"`
	Status string         `json:"status" enum:"deleted"`
}

func (s *Server) deleteAttachmentText(ctx context.Context, in *DigestInput) (*httpapi.Body[AttachmentTextDeleted], error) {
	err := s.db.DeleteBlobText(ctx, in.BLAKE3)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("no extracted text for " + in.BLAKE3.String())
	}
	return reply(AttachmentTextDeleted{BLAKE3: in.BLAKE3, Status: "deleted"}, err)
}

// openBlob opens stored bytes, or says that they are missing.
func (s *Server) openBlob(d content.Digest, missing string) (*os.File, os.FileInfo, error) {
	f, err := os.Open(s.blobs.Path(d))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, httpapi.NotFound.New(missing)
	}
	if err != nil {
		return nil, nil, failure(err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, failure(err)
	}
	return f, info, nil
}

func (s *Server) blob(_ context.Context, in *DigestInput) (*huma.StreamResponse, error) {
	f, info, err := s.openBlob(in.BLAKE3, "no stored bytes with blake3 "+in.BLAKE3.String())
	if err != nil {
		return nil, err
	}
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		defer f.Close()
		hctx.SetHeader("Content-Type", "application/octet-stream")
		hctx.SetHeader("Content-Length", strconv.FormatInt(info.Size(), 10))
		hctx.SetStatus(http.StatusOK)
		_, _ = io.Copy(hctx.BodyWriter(), f)
	}}, nil
}

var previewable = map[string]bool{"application/pdf": true, "image/png": true, "image/jpeg": true, "image/gif": true,
	"image/webp": true, "audio/mpeg": true, "audio/aac": true, "audio/flac": true, "audio/x-flac": true, "audio/ogg": true,
	"audio/wave": true, "audio/aiff": true, "audio/midi": true, "video/mp4": true, "video/webm": true, "video/ogg": true,
	"video/avi": true}

func (s *Server) attachmentPreview(ctx context.Context, in *DigestInput) (*huma.StreamResponse, error) {
	known, err := s.db.KnownAttachment(ctx, in.BLAKE3)
	if err != nil {
		return nil, failure(err)
	}
	if !known {
		return nil, httpapi.NotFound.New("no attachment with blake3 " + in.BLAKE3.String())
	}
	f, info, err := s.openBlob(in.BLAKE3, "the attachment's bytes are missing")
	if err != nil {
		return nil, err
	}
	head := make([]byte, 3072)
	n, err := f.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		f.Close()
		return nil, failure(err)
	}
	typ := http.DetectContentType(head[:n])
	if typ == "application/octet-stream" {
		typ = mimetype.Detect(head[:n]).String()
	}
	if !previewable[typ] {
		f.Close()
		return nil, errUnpreviewable.New("preview uses extracted text for this file type")
	}
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		defer f.Close()
		r, w := humago.Unwrap(hctx)
		w.Header().Set("Content-Type", typ)
		w.Header().Set("Content-Disposition", "inline")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'")
		http.ServeContent(w, r, "preview", info.ModTime(), f)
	}}, nil
}
