package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var (
	errRetired = httpapi.Kind{Tag: "MessageRetired", Status: http.StatusGone,
		Doc:   "The message was retired from the archive. retired says what it was and, in replacement, which record took its place.",
		Extra: map[string]reflect.Type{"retired": reflect.TypeFor[store.RetiredMessage]()}}
	errMailThreadConflict = httpapi.Kind{Tag: "MailThreadConflict", Status: http.StatusConflict,
		Doc: "The thread ID is an old one whose mail the provider now files under several threads. choices lists " +
			"those thread IDs, and unanchored_path is the route for the messages that belong to none of them.",
		Extra: map[string]reflect.Type{
			"code":            reflect.TypeFor[string](),
			"source":          reflect.TypeFor[string](),
			"conflict_key":    reflect.TypeFor[string](),
			"choices":         reflect.TypeFor[[]string](),
			"unanchored_path": reflect.TypeFor[string](),
		}}
)

// registerMessagesAPI describes the routes over single messages, threads, mail conflicts, source coverage, ad-hoc SQL and import reports.
func (s *Server) registerMessagesAPI(api huma.API) {
	huma.Register(api, httpapi.Operation{ID: "listThreads", Method: http.MethodGet, Path: "/v1/threads", Tag: "messages",
		Summary: "List conversations by their latest message",
		Description: "One row per thread, with its message count, latest sender and a preview. Read a row's " +
			"messages with the thread route, passing its source and thread_id.",
	}.For(api), s.browseThreads)
	huma.Register(api, httpapi.Operation{ID: "getMessage", Method: http.MethodGet, Path: "/v1/messages/{id}", Tag: "messages",
		Summary: "Read one message with its attachments",
		Errors:  []httpapi.Kind{httpapi.NotFound, errRetired},
	}.For(api), s.message)
	huma.Register(api, httpapi.Operation{ID: "getThread", Method: http.MethodGet, Path: "/v1/threads/{id}", Tag: "messages",
		Summary: "Read a page of one conversation, oldest first",
		Description: "Without a position the page starts at the oldest message. Use at most one of before, after, " +
			"around and latest. has_before and has_after say whether more messages exist on either side.",
		Errors: []httpapi.Kind{httpapi.NotFound, errMailThreadConflict},
	}.For(api), s.thread)
	huma.Register(api, httpapi.Operation{ID: "getMailConflict", Method: http.MethodGet, Path: "/v1/mail-conflicts/{id}", Tag: "messages",
		Summary:     "Read the messages of a mail thread conflict that belong to no current thread",
		Description: "Newest first. A MailThreadConflict failure names this route in unanchored_path.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.mailConflict)
	huma.Register(api, httpapi.Operation{ID: "getMessageBranch", Method: http.MethodGet, Path: "/v1/messages/{id}/branch", Tag: "messages",
		Summary: "Read a message and the messages it answers, back to the start of the conversation",
		Description: "For conversations that fork, such as AI chats with edited prompts: only the ancestors of " +
			"this message, in reply order. incomplete is set when the oldest one answers a message that is not " +
			"in the archive.",
		Errors: []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.messageBranch)
	huma.Register(api, httpapi.Operation{ID: "getMessageParent", Method: http.MethodGet, Path: "/v1/messages/{id}/parent", Tag: "messages",
		Summary: "Read the message a message answers",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}.For(api), s.messageParent)
	huma.Register(api, httpapi.Operation{ID: "setSourceCoverage", Method: http.MethodPut, Path: "/v1/sources/{source}/coverage", Tag: "messages",
		Summary:     "Record what a source is known to hold",
		Description: "The note is shown with the source's statistics. It does not count as a sync.",
	}.For(api), s.setCoverage)
	huma.Register(api, httpapi.Operation{ID: "runQuery", Method: http.MethodPost, Path: "/v1/query", Tag: "messages",
		Summary: "Run one read-only SQL statement over the archive",
		Description: "Runs in a read-only transaction with a statement timeout and a row cap, so a read-only token " +
			"may call it. Each row is an array in the order of columns. truncated is set when the cap cut the " +
			"result short.",
	}.For(api), s.query)
	huma.Register(api, httpapi.Operation{ID: "listImportReports", Method: http.MethodGet, Path: "/v1/import-reports", Tag: "imports",
		Summary: "List past imports with their outcome, newest first",
	}.For(api), s.importReports)
}

type browseThreadsInput struct {
	Source        string `query:"source" doc:"Only this source, such as gmail or whatsapp."`
	Order         string `query:"order" enum:"asc,desc" doc:"By latest message: newest first (desc, the default) or oldest first."`
	From          string `query:"from" doc:"Sender contains this, ignoring case."`
	To            string `query:"to" doc:"A recipient contains this, ignoring case."`
	Person        string `query:"person" doc:"Sent or received by this contact, by name."`
	Subject       string `query:"subject" doc:"Subject contains this, ignoring case."`
	Limit         int    `query:"limit" default:"50" minimum:"1" maximum:"500"`
	Offset        int    `query:"offset" default:"0" minimum:"0" maximum:"10000" doc:"Past 10000, narrow the filters instead."`
	Since         string `query:"since" format:"date" doc:"Sent on or after this day, YYYY-MM-DD."`
	Until         string `query:"until" format:"date" doc:"Sent before this day, YYYY-MM-DD."`
	MailboxID     int64  `query:"mailbox_id" minimum:"1" doc:"Only this mail folder. Needs source."`
	HasAttachment string `query:"has_attachment" enum:"true,false" doc:"Only messages with, or without, attachments."`
}

func (s *Server) browseThreads(ctx context.Context, in *browseThreadsInput) (*httpapi.Body[[]store.ThreadGroup], error) {
	o := store.BrowseOpts{Source: in.Source, Order: in.Order, From: in.From, To: in.To, Person: in.Person,
		Subject: in.Subject, Limit: in.Limit, Offset: in.Offset, MailboxID: in.MailboxID}
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
	if err := o.Validate(); err != nil {
		return nil, invalid(err)
	}
	groups, err := s.read.BrowseThreads(ctx, o)
	if _, noContact := errors.AsType[*store.ErrNoContact](err); noContact || errors.Is(err, store.ErrMailboxSource) {
		return nil, invalid(err)
	}
	return list(groups, err)
}

type messageInput struct {
	ID string `path:"id" doc:"The message's ref, 12 hex characters as cited in bank:<ref>, or its numeric row ID."`
}

// message tries a ref first: it is 12 hex characters, so an all-digit one
// would otherwise parse as a row id no archive this size will ever have.
func (s *Server) message(ctx context.Context, in *messageInput) (*httpapi.Body[store.MessageDetail], error) {
	var m store.Message
	var atts []store.Attachment
	var err error
	if store.ValidRef(in.ID) == nil {
		m, atts, err = s.read.GetMessageByRef(ctx, in.ID)
	} else {
		id, parseErr := strconv.ParseInt(in.ID, 10, 64)
		if parseErr != nil {
			return nil, httpapi.Invalid.New("invalid id")
		}
		m, atts, err = s.read.GetMessage(ctx, id)
	}
	if retired, ok := errors.AsType[*store.RetiredError](err); ok {
		return nil, errRetired.New(retired.Error()).With("retired", retired.Retired)
	}
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New(fmt.Sprintf("no message %s", in.ID))
	}
	if err != nil {
		// A message store that cannot answer is not a missing message: a 404
		// here would teach every client to treat an outage as an empty archive.
		return nil, internal(fmt.Errorf("message %s: %w", in.ID, err))
	}
	return &httpapi.Body[store.MessageDetail]{Body: store.MessageDetail{Message: m, Attachments: atts}}, nil
}

type threadInput struct {
	ID      string `path:"id" doc:"The thread_id of any of its messages."`
	Source  string `query:"source" doc:"The thread's source. Needed when several sources use this thread ID."`
	Limit   int    `query:"limit" default:"0" minimum:"0" maximum:"2000" doc:"Maximum messages. 0 means 2000."`
	Before  int64  `query:"before" minimum:"1" doc:"The page that ends just before this message ID."`
	After   int64  `query:"after" minimum:"1" doc:"The page that starts just after this message ID."`
	Around  int64  `query:"around" minimum:"1" doc:"The page with this message ID in its middle."`
	Latest  bool   `query:"latest" doc:"The page that ends at the newest message."`
	Current bool   `query:"current" doc:"Read the ID as a current thread. Without it, an old mail thread ID is followed to the thread that replaced it."`
}

func (s *Server) thread(ctx context.Context, in *threadInput) (*httpapi.Body[store.Thread], error) {
	o := store.ThreadOpts{Limit: in.Limit, Before: in.Before, After: in.After, Around: in.Around, Latest: in.Latest, Current: in.Current}
	if err := o.Validate(); err != nil {
		return nil, invalid(err)
	}
	thread, err := s.read.GetThreadPage(ctx, in.Source, in.ID, o)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New(fmt.Sprintf("no thread %q", in.ID))
	}
	if _, ambiguous := errors.AsType[*store.AmbiguousThreadError](err); ambiguous {
		return nil, invalid(err)
	}
	if conflict, ok := errors.AsType[*store.MailThreadConflictError](err); ok {
		return nil, errMailThreadConflict.New(conflict.Error()).
			With("code", conflict.Code).
			With("source", conflict.Source).
			With("conflict_key", conflict.ConflictKey).
			With("choices", conflict.Choices).
			With("unanchored_path", conflict.UnanchoredPath).
			Recover("Read one of the current threads",
				"Request one of choices as the thread ID with current=true and this source, or request unanchored_path for the messages that belong to none of them.")
	}
	return reply(thread, err)
}

type mailConflictInput struct {
	Key    string `path:"id" doc:"The conflict_key of a MailThreadConflict failure."`
	Source string `query:"source" required:"true" doc:"The mail source the conflict is in."`
	Before int64  `query:"before" default:"0" minimum:"0" doc:"Only messages older than this message ID. 0 starts at the newest."`
	Limit  int    `query:"limit" default:"100" minimum:"1" maximum:"2000"`
}

func (s *Server) mailConflict(ctx context.Context, in *mailConflictInput) (*httpapi.Body[store.Thread], error) {
	if err := archive.ValidSource(in.Source); err != nil {
		return nil, invalid(err)
	}
	page, err := s.read.MailConflictMessages(ctx, in.Source, in.Key, in.Before, in.Limit)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New(err.Error())
	}
	return reply(page, err)
}

type messageIDInput struct {
	ID int64 `path:"id" minimum:"1" doc:"The message's numeric row ID."`
}

func (s *Server) messageBranch(ctx context.Context, in *messageIDInput) (*httpapi.Body[store.Branch], error) {
	branch, err := s.db.MessageBranch(ctx, in.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("message is not in the archive")
	}
	return reply(branch, err)
}

func (s *Server) messageParent(ctx context.Context, in *messageIDInput) (*httpapi.Body[store.Message], error) {
	m, err := s.db.MessageParent(ctx, in.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("parent message is not in the archive")
	}
	return reply(m, err)
}

type coverageInput struct {
	Source string `path:"source" doc:"The source the note is about, such as gmail or whatsapp."`
	Body   struct {
		Text string `json:"text,omitempty" doc:"What the source holds, in a sentence. Empty or absent clears the note."`
	}
}

type sourceCoverage struct {
	Source   string `json:"source"`
	Coverage string `json:"coverage"`
}

func (s *Server) setCoverage(ctx context.Context, in *coverageInput) (*httpapi.Body[sourceCoverage], error) {
	if err := s.db.SetCoverage(ctx, in.Source, in.Body.Text); err != nil {
		if fail.IsOp(err) {
			return nil, internal(err)
		}
		return nil, invalid(err)
	}
	return &httpapi.Body[sourceCoverage]{Body: sourceCoverage{Source: in.Source, Coverage: in.Body.Text}}, nil
}

type queryInput struct {
	Body struct {
		SQL   string `json:"sql" minLength:"1" doc:"One SQL statement that only reads."`
		Limit int    `json:"limit,omitempty" minimum:"0" maximum:"10000" doc:"Maximum rows. 0 or absent means 100."`
	}
}

// query leaves safety to the store (read-only transaction, statement timeout,
// row cap) and only separates wrong SQL from a broken archive.
func (s *Server) query(ctx context.Context, in *queryInput) (*httpapi.Body[store.QueryResult], error) {
	if strings.TrimSpace(in.Body.SQL) == "" {
		return nil, httpapi.Invalid.New("missing sql")
	}
	res, err := s.read.Query(ctx, in.Body.SQL, in.Body.Limit)
	if _, bad := errors.AsType[*store.BadQueryError](err); bad {
		return nil, invalid(err)
	}
	return reply(res, err)
}

type importReportsInput struct {
	Before int64 `query:"before" default:"0" minimum:"0" doc:"Only reports with an ID below this one. 0 starts at the newest."`
	Limit  int   `query:"limit" default:"50" minimum:"1" maximum:"100"`
}

func (s *Server) importReports(ctx context.Context, in *importReportsInput) (*httpapi.Body[[]store.ImportReport], error) {
	return list(s.db.ImportReports(ctx, in.Before, in.Limit))
}
