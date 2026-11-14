package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
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

var (
	ListThreads = httpapi.Op[ListThreadsInput, []store.ThreadGroup]{Operation: httpapi.Operation{ID: "listThreads", Method: http.MethodGet, Path: "/v1/threads", Tag: "messages",
		Summary: "List conversations by their latest message",
		Description: "One row per thread, with its message count, latest sender and a preview. Read a row's " +
			"messages with the thread route, passing its source and thread_id.",
	}}
	GetMessage = httpapi.Op[MessageInput, store.MessageDetail]{Operation: httpapi.Operation{ID: "getMessage", Method: http.MethodGet, Path: "/v1/messages/{ref}", Tag: "messages",
		Summary: "Read one message with its attachments",
		Errors:  []httpapi.Kind{httpapi.NotFound, errRetired},
	}}
	GetThread = httpapi.Op[ThreadInput, store.Thread]{Operation: httpapi.Operation{ID: "getThread", Method: http.MethodGet, Path: "/v1/threads/{id}", Tag: "messages",
		Summary: "Read a page of one conversation, oldest first",
		Description: "Without a position the page starts at the oldest message. Use at most one of before, after, " +
			"around and latest. has_before and has_after say whether more messages exist on either side.",
		Errors: []httpapi.Kind{httpapi.NotFound, errMailThreadConflict},
	}}
	GetMailConflict = httpapi.Op[MailConflictInput, store.Thread]{Operation: httpapi.Operation{ID: "getMailConflict", Method: http.MethodGet, Path: "/v1/mail-conflicts/{id}", Tag: "messages",
		Summary:     "Read the messages of a mail thread conflict that belong to no current thread",
		Description: "Newest first. A MailThreadConflict failure names this route in unanchored_path.",
		Errors:      []httpapi.Kind{httpapi.NotFound},
	}}
	GetMessageBranch = httpapi.Op[MessageInput, store.Branch]{Operation: httpapi.Operation{ID: "getMessageBranch", Method: http.MethodGet, Path: "/v1/messages/{ref}/branch", Tag: "messages",
		Summary: "Read a message and the messages it answers, back to the start of the conversation",
		Description: "For conversations that fork, such as AI chats with edited prompts: only the ancestors of " +
			"this message, in reply order. incomplete is set when the oldest one answers a message that is not " +
			"in the archive.",
		Errors: []httpapi.Kind{httpapi.NotFound},
	}}
	GetMessageParent = httpapi.Op[MessageInput, store.Message]{Operation: httpapi.Operation{ID: "getMessageParent", Method: http.MethodGet, Path: "/v1/messages/{ref}/parent", Tag: "messages",
		Summary: "Read the message a message answers",
		Errors:  []httpapi.Kind{httpapi.NotFound},
	}}
	SetSourceCoverage = httpapi.Op[CoverageInput, SourceCoverage]{Operation: httpapi.Operation{ID: "setSourceCoverage", Method: http.MethodPut, Path: "/v1/sources/{source}/coverage", Tag: "messages",
		Summary:     "Record what a source is known to hold",
		Description: "The note is shown with the source's statistics. It does not count as a sync.",
		Writes:      true,
	}}
	RunQuery = httpapi.Op[QueryInput, store.QueryResult]{Operation: httpapi.Operation{ID: "runQuery", Method: http.MethodPost, Path: "/v1/query", Tag: "messages",
		Summary: "Run one read-only SQL query over the archive",
		Description: "The query is declared as a cursor in a read-only transaction with a statement timeout, so it " +
			"must be one SELECT, VALUES or TABLE, and a read token may call it. Reading stops at the row cap or at " +
			"8 MiB of values, and truncated says so; a value over 64 KiB is cut and counted in cut_values.",
	}}
	ListRawInputs = httpapi.Op[RawInputsInput, []store.RawInput]{Operation: httpapi.Operation{ID: "listRawInputs", Method: http.MethodGet, Path: "/v1/raw-inputs", Tag: "imports",
		Summary: "List stored raw inputs with the outcome of their latest import, newest first",
	}}
)

// registerMessagesAPI serves the routes over single messages, threads, mail conflicts, source coverage, ad-hoc SQL and import reports.
func (s *Server) registerMessagesAPI(api huma.API) {
	httpapi.Register(api, ListThreads, s.browseThreads)
	httpapi.Register(api, GetMessage, s.message)
	httpapi.Register(api, GetThread, s.thread)
	httpapi.Register(api, GetMailConflict, s.mailConflict)
	httpapi.Register(api, GetMessageBranch, s.messageBranch)
	httpapi.Register(api, GetMessageParent, s.messageParent)
	httpapi.Register(api, SetSourceCoverage, s.setCoverage)
	httpapi.Register(api, RunQuery, s.query)
	httpapi.Register(api, ListRawInputs, s.rawInputs)
}

type ListThreadsInput struct {
	Source        string `query:"source" doc:"Only this source, such as gmail or whatsapp."`
	Order         string `query:"order" enum:"asc,desc" doc:"By latest message: newest first (desc, the default) or oldest first."`
	From          string `query:"from" doc:"Sender contains this, ignoring case."`
	To            string `query:"to" doc:"A recipient contains this, ignoring case."`
	Person        string `query:"person" doc:"Sent or received by this contact, by name."`
	Subject       string `query:"subject" doc:"Subject contains this, ignoring case."`
	Since         string `query:"since" format:"date" doc:"Sent on or after this day, YYYY-MM-DD."`
	Until         string `query:"until" format:"date" doc:"Sent before this day, YYYY-MM-DD."`
	MailboxID     int64  `query:"mailbox_id" minimum:"1" doc:"Only this mail folder. Needs source."`
	HasAttachment string `query:"has_attachment" enum:"true,false" doc:"Only messages with, or without, attachments."`
	httpapi.Page
}

func (s *Server) browseThreads(ctx context.Context, in *ListThreadsInput) (*httpapi.Body[[]store.ThreadGroup], error) {
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
		return nil, failure(err)
	}
	if o.Until, err = parseDate(in.Until); err != nil {
		return nil, failure(err)
	}
	if err := o.Validate(); err != nil {
		return nil, failure(err)
	}
	return list(s.read.BrowseThreads(ctx, o))
}

type MessageInput struct {
	Ref ref.Message `path:"ref" doc:"The message's ref, msg:<16 hex>."`
}

func (s *Server) message(ctx context.Context, in *MessageInput) (*httpapi.Body[store.MessageDetail], error) {
	m, atts, err := s.read.GetMessageByRef(ctx, in.Ref)
	if err != nil {
		return nil, failure(fmt.Errorf("message %s: %w", in.Ref, err))
	}
	return &httpapi.Body[store.MessageDetail]{Body: store.MessageDetail{Message: m, Attachments: atts}}, nil
}

type ThreadInput struct {
	ID      string      `path:"id" doc:"The thread_id of any of its messages."`
	Source  string      `query:"source" doc:"The thread's source. Needed when several sources use this thread ID."`
	Before  ref.Message `query:"before" doc:"The page that ends just before this message, by ref."`
	After   ref.Message `query:"after" doc:"The page that starts just after this message, by ref."`
	Around  ref.Message `query:"around" doc:"The page with this message, by ref, in its middle."`
	Latest  bool        `query:"latest" doc:"The page that ends at the newest message."`
	Current bool        `query:"current" doc:"Read the ID as a current thread. Without it, an old mail thread ID is followed to the thread that replaced it."`
	httpapi.PageSize
}

func (s *Server) thread(ctx context.Context, in *ThreadInput) (*httpapi.Body[store.Thread], error) {
	o := store.ThreadOpts{Limit: in.Limit, Before: in.Before, After: in.After, Around: in.Around, Latest: in.Latest, Current: in.Current}
	if err := o.Validate(); err != nil {
		return nil, failure(err)
	}
	thread, err := s.read.GetThreadPage(ctx, in.Source, in.ID, o)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New(fmt.Sprintf("no thread %q", in.ID))
	}
	return reply(thread, err)
}

func mailThreadConflict(conflict *store.MailThreadConflictError) error {
	return errMailThreadConflict.New(conflict.Error()).
		With("code", conflict.Code).
		With("source", conflict.Source).
		With("conflict_key", conflict.ConflictKey).
		With("choices", conflict.Choices).
		With("unanchored_path", conflict.UnanchoredPath).
		Recover("Read one of the current threads",
			"Request one of choices as the thread ID with current=true and this source, or request unanchored_path for the messages that belong to none of them.")
}

type MailConflictInput struct {
	Key    string      `path:"id" doc:"The conflict_key of a MailThreadConflict failure."`
	Source string      `query:"source" required:"true" doc:"The mail source the conflict is in."`
	Before ref.Message `query:"before" doc:"Only messages older than this message, by ref. Without it, the page starts at the newest."`
	httpapi.PageSize
}

func (s *Server) mailConflict(ctx context.Context, in *MailConflictInput) (*httpapi.Body[store.Thread], error) {
	if err := ingest.ValidSource(in.Source); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return reply(s.read.MailConflictMessages(ctx, in.Source, in.Key, in.Before, in.Limit))
}

func (s *Server) messageBranch(ctx context.Context, in *MessageInput) (*httpapi.Body[store.Branch], error) {
	branch, err := s.db.MessageBranch(ctx, in.Ref)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("message is not in the archive")
	}
	return reply(branch, err)
}

func (s *Server) messageParent(ctx context.Context, in *MessageInput) (*httpapi.Body[store.Message], error) {
	m, err := s.db.MessageParent(ctx, in.Ref)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpapi.NotFound.New("parent message is not in the archive")
	}
	return reply(m, err)
}

type CoverageInput struct {
	Source string `path:"source" doc:"The source the note is about, such as gmail or whatsapp."`
	Body   CoverageInputBody
}

type CoverageInputBody struct {
	Text string `json:"text,omitempty" doc:"What the source holds, in a sentence. Empty or absent clears the note."`
}

type SourceCoverage struct {
	Source   string `json:"source"`
	Coverage string `json:"coverage"`
}

func (s *Server) setCoverage(ctx context.Context, in *CoverageInput) (*httpapi.Body[SourceCoverage], error) {
	if err := ingest.ValidSource(in.Source); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if err := s.db.SetCoverage(ctx, in.Source, in.Body.Text); err != nil {
		return nil, failure(err)
	}
	return &httpapi.Body[SourceCoverage]{Body: SourceCoverage{Source: in.Source, Coverage: in.Body.Text}}, nil
}

type QueryInput struct {
	Body QueryInputBody
}

type QueryInputBody struct {
	SQL   string `json:"sql" minLength:"1" doc:"One SQL query: SELECT, VALUES or TABLE."`
	Limit int    `json:"limit,omitempty" minimum:"0" maximum:"10000" doc:"Maximum rows. 0 or absent means 100."`
}

// query leaves safety to the store (read-only cursor, statement timeout, row
// and size caps) and only separates wrong SQL from a broken archive.
func (s *Server) query(ctx context.Context, in *QueryInput) (*httpapi.Body[store.QueryResult], error) {
	if strings.TrimSpace(in.Body.SQL) == "" {
		return nil, httpapi.Invalid.New("missing sql")
	}
	return reply(s.read.Query(ctx, in.Body.SQL, in.Body.Limit))
}

type RawInputsInput struct {
	Before int64 `query:"before" default:"0" minimum:"0" doc:"Only raw inputs with an ID below this one. 0 starts at the newest."`
	httpapi.PageSize
}

func (s *Server) rawInputs(ctx context.Context, in *RawInputsInput) (*httpapi.Body[[]store.RawInput], error) {
	return list(s.db.RawInputs(ctx, in.Before, in.Limit))
}
