package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var errRevisionConflict = httpapi.Kind{Tag: "LibraryRevisionConflict", Status: http.StatusConflict,
	Doc:   "The record changed since expected_revision was read. Read it again and repeat the edit on its current revision.",
	Extra: map[string]reflect.Type{"code": reflect.TypeFor[string]()}}

var Search = httpapi.Op[SearchInput, catalog.Result]{Operation: httpapi.Operation{ID: "search", Method: http.MethodGet, Path: "/v1/search", Tag: "search",
	Summary: "Search messages, the media library, attachments and files on disks at once",
	Description: "q is required, and match means the same for every kind of record: any word (the default), " +
		"every word, or a phrase. Files on disks have no phrase match and are left out of a phrase search. " +
		"Messages are ranked by relevance; library groups are sorted by title or date. kind narrows the search " +
		"to one group (message, item, activity, collection, file, page) or to one kind inside a group; file " +
		"covers library files, attachments and files on disks. from, to, person, subject, mailbox_id and " +
		"has_attachment restrict the search to messages, and cannot be combined with a kind other than message " +
		"or with account. since and until take YYYY-MM-DD here. limit and offset apply to each group on its " +
		"own. coverage says what the result does not prove: an absent activity, for one, is not evidence that " +
		"something was not watched, because only imported records are searched.",
}}

// registerSearchAPI serves the one search over every kind of record.
func (s *Server) registerSearchAPI(api huma.API) {
	httpapi.Register(api, Search, s.search)
}

var (
	libraryNotFound = []httpapi.Kind{httpapi.NotFound}
	libraryEdit     = []httpapi.Kind{httpapi.NotFound, errRevisionConflict}

	ListLibraryItems = httpapi.Op[LibraryFilters, []library.Item]{Operation: httpapi.Operation{ID: "listLibraryItems", Method: http.MethodGet, Path: "/v1/library/items", Tag: "library",
		Summary: "List media items (films, episodes, tracks, books and more), sorted by title",
	}}
	CreateLibraryItem = httpapi.Op[CreateLibraryItemInput, library.Item]{Operation: httpapi.Operation{ID: "createLibraryItem", Method: http.MethodPost, Path: "/v1/library/items", Tag: "library",
		Summary: "Add a media item by hand",
		Description: "kind and title are required. The server assigns id, source (manual), account and external_id; " +
			"what the body says for them is ignored.",
		Writes: true,
	}}
	SummarizeLibraryItems = httpapi.Op[SummarizeLibraryItemsInput, []library.ItemSummary]{Operation: httpapi.Operation{ID: "summarizeLibraryItems", Method: http.MethodPost, Path: "/v1/library/items/summaries", Tag: "library",
		Summary:     "Look up the title, kind and source of up to 50 items by ID",
		Description: "Answers in the order the IDs were given, each item once. Unknown IDs are left out.",
	}}
	GetLibraryItem = httpapi.Op[LibraryIDInput, library.Item]{Operation: httpapi.Operation{ID: "getLibraryItem", Method: http.MethodGet, Path: "/v1/library/items/{id}", Tag: "library",
		Summary: "Return one media item with its state, evidence and linked files",
		Errors:  libraryNotFound,
	}}
	SetLibraryItemState = httpapi.Op[LibraryStateInput, library.State]{Operation: httpapi.Operation{ID: "setLibraryItemState", Method: http.MethodPut, Path: "/v1/library/items/{id}/state", Tag: "library",
		Summary: "Replace an item's personal state: status, rating, progress, notes and tags",
		Description: "The body replaces the whole state, so send every field that should stay. expected_revision is " +
			"the state's revision as last read, 0 for an item whose state was never set.",
		Errors: libraryEdit,
		Writes: true,
	}}
	ListLibraryItemStateHistory = httpapi.Op[LibraryIDInput, []library.State]{Operation: httpapi.Operation{ID: "listLibraryItemStateHistory", Method: http.MethodGet, Path: "/v1/library/items/{id}/state-history", Tag: "library",
		Summary: "List every revision of an item's personal state",
		Errors:  libraryNotFound,
	}}

	ListLibraryActivity = httpapi.Op[LibraryFilters, []library.Activity]{Operation: httpapi.Operation{ID: "listLibraryActivity", Method: http.MethodGet, Path: "/v1/library/activity", Tag: "library",
		Summary: "List what was watched, listened to, read, played or bought, newest first",
	}}
	GetLibraryActivity = httpapi.Op[LibraryIDInput, library.Activity]{Operation: httpapi.Operation{ID: "getLibraryActivity", Method: http.MethodGet, Path: "/v1/library/activity/{id}", Tag: "library",
		Summary: "Return one activity record with its evidence",
		Errors:  libraryNotFound,
	}}

	// ListLibraryCollections answers in the shape projection picks, so its
	// body is JSON already encoded.
	ListLibraryCollections = httpapi.Op[LibraryCollectionsInput, json.RawMessage]{Operation: httpapi.Operation{ID: "listLibraryCollections", Method: http.MethodGet, Path: "/v1/library/collections", Tag: "library",
		Summary: "List playlists, watchlists and other collections, sorted by title",
		Description: "Each collection carries its current snapshot: with its entry count by default, with the " +
			"entries themselves when projection is full.",
	}}
	CreateLibraryCollection = httpapi.Op[CreateLibraryCollectionInput, library.Collection]{Operation: httpapi.Operation{ID: "createLibraryCollection", Method: http.MethodPost, Path: "/v1/library/collections", Tag: "library",
		Summary: "Create a personal collection",
		Description: "title and kind (playlist, watchlist, library or list) are required. snapshot.entries are the " +
			"first entries. The server assigns id, source (manual), account and external_id.",
		Writes: true,
	}}
	GetLibraryCollection = httpapi.Op[LibraryIDInput, library.Collection]{Operation: httpapi.Operation{ID: "getLibraryCollection", Method: http.MethodGet, Path: "/v1/library/collections/{id}", Tag: "library",
		Summary: "Return one collection with the entries of its current snapshot",
		Errors:  libraryNotFound,
	}}
	EditLibraryCollection = httpapi.Op[CollectionEditInput, library.Collection]{Operation: httpapi.Operation{ID: "editLibraryCollection", Method: http.MethodPut, Path: "/v1/library/collections/{id}", Tag: "library",
		Summary: "Replace a personal collection's title, description and entries",
		Description: "Only collections created here can be edited; imported ones are read-only. The body replaces " +
			"all entries. expected_revision is the collection's revision as last read.",
		Errors: libraryEdit,
		Writes: true,
	}}
	// ListLibraryCollectionSnapshots answers in the shape projection picks.
	ListLibraryCollectionSnapshots = httpapi.Op[SnapshotsInput, json.RawMessage]{Operation: httpapi.Operation{ID: "listLibraryCollectionSnapshots", Method: http.MethodGet, Path: "/v1/library/collections/{id}/snapshots", Tag: "library",
		Summary: "List the recorded states of a collection, newest first",
		Description: "By default a page of snapshots with their entry counts. With projection full, every snapshot " +
			"with its entries, and limit and offset are ignored.",
		Errors: libraryNotFound,
	}}
	GetLibraryCollectionSnapshot = httpapi.Op[SnapshotInput, library.Snapshot]{Operation: httpapi.Operation{ID: "getLibraryCollectionSnapshot", Method: http.MethodGet, Path: "/v1/library/collections/{id}/snapshots/{snapshotId}", Tag: "library",
		Summary: "Return one recorded state of a collection with its entries",
		Errors:  libraryNotFound,
	}}

	ListLibraryFiles = httpapi.Op[LibraryFilters, []library.File]{Operation: httpapi.Operation{ID: "listLibraryFiles", Method: http.MethodGet, Path: "/v1/library/files", Tag: "library",
		Summary:     "List the files kept in the library, sorted by filename",
		Description: "q also searches the text read from the files. kind does not apply to files.",
	}}
	GetLibraryFile = httpapi.Op[LibraryIDInput, library.File]{Operation: httpapi.Operation{ID: "getLibraryFile", Method: http.MethodGet, Path: "/v1/library/files/{id}", Tag: "library",
		Summary: "Return one library file's record. Its bytes are at /v1/blobs/{blake3}",
		Errors:  libraryNotFound,
	}}
	GetLibraryPage = httpapi.Op[LibraryIDInput, library.Page]{Operation: httpapi.Operation{ID: "getLibraryPage", Method: http.MethodGet, Path: "/v1/library/pages/{id}", Tag: "library",
		Summary: "Return one published note with its body",
		Errors:  libraryNotFound,
	}}
)

// registerLibraryAPI serves the routes over the media library.
func (s *Server) registerLibraryAPI(api huma.API) {
	httpapi.Register(api, ListLibraryItems, s.libraryItems)
	httpapi.Register(api, CreateLibraryItem, s.createLibraryItem, libraryBody(http.StatusCreated))
	httpapi.Register(api, SummarizeLibraryItems, s.libraryItemSummaries, libraryBody(http.StatusOK))
	httpapi.Register(api, GetLibraryItem, s.libraryItem)
	httpapi.Register(api, SetLibraryItemState, s.setLibraryState, libraryBody(http.StatusOK))
	httpapi.Register(api, ListLibraryItemStateHistory, s.libraryStateHistory)

	httpapi.Register(api, ListLibraryActivity, s.libraryActivity)
	httpapi.Register(api, GetLibraryActivity, s.libraryActivityRecord)

	httpapi.Register(api, ListLibraryCollections, s.libraryCollections, eitherList[library.CollectionSummary, library.Collection](api))
	httpapi.Register(api, CreateLibraryCollection, s.createLibraryCollection, libraryBody(http.StatusCreated))
	httpapi.Register(api, GetLibraryCollection, s.libraryCollection)
	httpapi.Register(api, EditLibraryCollection, s.editLibraryCollection, libraryBody(http.StatusOK))
	httpapi.Register(api, ListLibraryCollectionSnapshots, s.libraryCollectionSnapshots, eitherList[library.SnapshotSummary, library.Snapshot](api))
	httpapi.Register(api, GetLibraryCollectionSnapshot, s.libraryCollectionSnapshot)

	httpapi.Register(api, ListLibraryFiles, s.libraryFiles)
	httpapi.Register(api, GetLibraryFile, s.libraryFile)
	httpapi.Register(api, GetLibraryPage, s.libraryPage)
}

// bulkBodyReadTimeout replaces Huma's 5 second default on routes whose body
// can be many megabytes from a slow client.
const bulkBodyReadTimeout = 2 * time.Minute

// The older library routes took 32 MiB of JSON, required no field and
// refused unknown ones. libraryBody and Strict keep all three.
func libraryBody(status int) func(*huma.Operation) {
	return func(op *huma.Operation) {
		op.DefaultStatus, op.MaxBodyBytes, op.SkipValidateBody = status, 32<<20, true
		op.BodyReadTimeout = bulkBodyReadTimeout
	}
}

// Strict is a JSON body that refuses fields T does not have.
type Strict[T any] struct{ Value T }

func (b *Strict[T]) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&b.Value)
}

func (b Strict[T]) MarshalJSON() ([]byte, error) { return json.Marshal(b.Value) }

func (Strict[T]) Schema(r huma.Registry) *huma.Schema {
	schema := *huma.SchemaFromType(r, reflect.TypeFor[T]())
	schema.Required = nil
	return &schema
}

// eitherList documents a route whose projection parameter picks between two list shapes.
func eitherList[Summary, Full any](api huma.API) func(*huma.Operation) {
	return func(op *huma.Operation) {
		schemas := api.OpenAPI().Components.Schemas
		op.Responses["200"] = &huma.Response{Description: http.StatusText(http.StatusOK), Content: map[string]*huma.MediaType{
			"application/json": {Schema: &huma.Schema{OneOf: []*huma.Schema{
				schemas.Schema(reflect.TypeFor[[]Summary](), true, ""),
				schemas.Schema(reflect.TypeFor[[]Full](), true, ""),
			}}},
		}}
	}
}

// projected is a list in the shape a projection picked, encoded here because
// the route's two shapes have no one Go type.
func projected[T any](v []T, err error) (*httpapi.Body[json.RawMessage], error) {
	if err != nil {
		return nil, libraryError(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil, internal(err)
	}
	return &httpapi.Body[json.RawMessage]{Body: b}, nil
}

// libraryError is failure for the library's records, whose values reach
// Postgres as given: a value it refuses is the caller's.
func libraryError(err error) error {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch {
		case strings.HasPrefix(pgErr.Code, "22"), pgErr.Code == "54000":
			return httpapi.Invalid.New(pgErr.Message)
		case pgErr.Code == "23503", pgErr.Code == "23514":
			return httpapi.Invalid.New("invalid library record or missing linked item")
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		return httpapi.NotFound.New("library record not found")
	}
	return failure(err)
}

func libraryReply[T any](v T, err error) (*httpapi.Body[T], error) {
	if err != nil {
		return nil, libraryError(err)
	}
	return &httpapi.Body[T]{Body: v}, nil
}

func libraryList[T any](v []T, err error) (*httpapi.Body[[]T], error) {
	if err != nil {
		return nil, libraryError(err)
	}
	return list(v, nil)
}

// LibraryFilters is exported because Huma reads parameters of an embedded
// struct only when its type is.
type LibraryFilters struct {
	Q       string `query:"q" doc:"Words to find, at most 4096 bytes."`
	Match   string `query:"match" enum:"any,all,phrase" doc:"any word (the default), every word, or the words adjacent and in order."`
	Source  string `query:"source" doc:"Only records from this source, such as netflix, youtube-media or manual."`
	Account string `query:"account" doc:"Only records of this account at the source."`
	Kind    string `query:"kind" enum:"message,item,activity,collection,file,page,video,movie,series,episode,track,album,podcast,book,article,other,watch,listen,read,play,view,purchase,playlist,library,watchlist,list" doc:"Only this kind. Items are video, movie, series, episode, track, album, podcast, book, article or other; activity is watch, listen, read, play, view, purchase or other; collections are playlist, library, watchlist or list. The searches also take a group: item, activity, collection, file, page, and message in the combined search."`
	ItemID  string `query:"item_id" doc:"Only activity for this item, or files linked to it."`
	Since   string `query:"since" doc:"Only activity on or after this day (YYYY-MM-DD) or instant (RFC 3339)."`
	Until   string `query:"until" doc:"Only activity before this day (YYYY-MM-DD) or instant (RFC 3339)."`
	httpapi.Page
}

func (f LibraryFilters) options() (library.ListOptions, error) {
	o := library.ListOptions{Query: f.Q, Match: f.Match, Source: f.Source, Account: f.Account, Kind: f.Kind,
		ItemID: f.ItemID, Since: f.Since, Until: f.Until, Limit: f.Limit, Offset: f.Offset}
	return o, o.Validate()
}

type LibraryIDInput struct {
	ID string `path:"id" doc:"The record's ID, which is also its ref, such as item:<32 hex>."`
}

type SearchInput struct {
	LibraryFilters
	From          string `query:"from" doc:"Message sender contains this, ignoring case."`
	To            string `query:"to" doc:"A message recipient contains this, ignoring case."`
	Person        string `query:"person" doc:"Messages sent or received by this contact, by name."`
	Subject       string `query:"subject" doc:"Message subject contains this, ignoring case."`
	Fuzzy         int    `query:"fuzzy" default:"1" minimum:"0" maximum:"2" doc:"Typos tolerated per word in messages."`
	MailboxID     int64  `query:"mailbox_id" minimum:"1" doc:"Only this mail folder. Needs source."`
	HasAttachment string `query:"has_attachment" enum:"true,false" doc:"Only messages with, or without, attachments."`
}

func (s *Server) search(ctx context.Context, in *SearchInput) (*httpapi.Body[catalog.Result], error) {
	o, err := in.options()
	if err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	messages := store.SearchOpts{Source: o.Source, From: in.From, To: in.To, Person: in.Person, Subject: in.Subject,
		Match: in.Match, Fuzzy: in.Fuzzy, Limit: o.Limit, Offset: o.Offset, MailboxID: in.MailboxID}
	if in.HasAttachment != "" {
		has := in.HasAttachment == "true"
		messages.HasAttachment = &has
	}
	if messages.Since, err = parseDate(in.Since); err != nil {
		return nil, failure(err)
	}
	if messages.Until, err = parseDate(in.Until); err != nil {
		return nil, failure(err)
	}
	return libraryReply(catalog.Find(ctx, s.read, s.catalogue, o.Query, messages, o))
}

func (s *Server) libraryItems(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.Item], error) {
	o, err := in.options()
	if err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryList(s.db.ListLibraryItems(ctx, o))
}

type CreateLibraryItemInput struct {
	Body Strict[library.Item]
}

func (s *Server) createLibraryItem(ctx context.Context, in *CreateLibraryItemInput) (*httpapi.Body[library.Item], error) {
	item := in.Body.Value
	item.Identity = newManualIdentity()
	item.ID = library.StableID("item", item.Identity)
	batch := library.ImportBatch{Version: 1, Items: []library.Item{item}}
	if err := batch.Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if _, err := s.db.ImportLibrary(ctx, batch); err != nil {
		return nil, libraryError(err)
	}
	return libraryReply(s.db.LibraryItem(ctx, item.ID))
}

type SummarizeLibraryItemsInput struct {
	Body Strict[library.ItemSummaryRequest]
}

func (s *Server) libraryItemSummaries(ctx context.Context, in *SummarizeLibraryItemsInput) (*httpapi.Body[[]library.ItemSummary], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryList(s.db.LibraryItemSummaries(ctx, in.Body.Value.IDs))
}

func (s *Server) libraryItem(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[library.Item], error) {
	return libraryReply(s.db.LibraryItem(ctx, in.ID))
}

type LibraryStateInput struct {
	ID   string `path:"id" doc:"The item's ID."`
	Body Strict[library.StateEdit]
}

func (s *Server) setLibraryState(ctx context.Context, in *LibraryStateInput) (*httpapi.Body[library.State], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryReply(s.db.SetLibraryState(ctx, in.ID, in.Body.Value))
}

func (s *Server) libraryStateHistory(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[[]library.State], error) {
	return libraryList(s.db.LibraryStateHistory(ctx, in.ID))
}

func (s *Server) libraryActivity(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.Activity], error) {
	o, err := in.options()
	if err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryList(s.db.ListLibraryActivity(ctx, o))
}

func (s *Server) libraryActivityRecord(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[library.Activity], error) {
	return libraryReply(s.db.LibraryActivity(ctx, in.ID))
}

type LibraryCollectionsInput struct {
	LibraryFilters
	Projection string `query:"projection" enum:"summary,full" doc:"full answers with every snapshot's entries, where the default has their count."`
}

func (s *Server) libraryCollections(ctx context.Context, in *LibraryCollectionsInput) (*httpapi.Body[json.RawMessage], error) {
	o, err := in.options()
	if err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if in.Projection == "full" {
		return projected(s.db.ListLibraryCollections(ctx, o))
	}
	return projected(s.db.ListLibraryCollectionSummaries(ctx, o))
}

type CreateLibraryCollectionInput struct {
	Body Strict[library.Collection]
}

func (s *Server) createLibraryCollection(ctx context.Context, in *CreateLibraryCollectionInput) (*httpapi.Body[library.Collection], error) {
	collection := in.Body.Value
	collection.Identity = newManualIdentity()
	collection.ID = library.StableID("collection", collection.Identity)
	collection.Personal = true
	if strings.TrimSpace(collection.Title) == "" {
		return nil, httpapi.Invalid.New("title is required")
	}
	if collection.Kind != "playlist" && collection.Kind != "watchlist" && collection.Kind != "library" && collection.Kind != "list" {
		return nil, httpapi.Invalid.New("invalid collection kind")
	}
	entries := []library.Entry{}
	if collection.Snapshot != nil {
		entries = collection.Snapshot.Entries
	}
	if err := (library.CollectionEdit{Title: collection.Title, Entries: entries}).Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryReply(s.db.CreateLibraryCollection(ctx, collection))
}

func (s *Server) libraryCollection(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[library.Collection], error) {
	return libraryReply(s.db.LibraryCollection(ctx, in.ID))
}

type CollectionEditInput struct {
	ID   string `path:"id" doc:"The collection's ID."`
	Body Strict[library.CollectionEdit]
}

func (s *Server) editLibraryCollection(ctx context.Context, in *CollectionEditInput) (*httpapi.Body[library.Collection], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryReply(s.db.EditLibraryCollection(ctx, in.ID, in.Body.Value))
}

type SnapshotsInput struct {
	ID         string `path:"id" doc:"The collection's ID."`
	Projection string `query:"projection" enum:"summary,full" doc:"full answers with every snapshot's entries, where the default has their count."`
	httpapi.Page
}

func (s *Server) libraryCollectionSnapshots(ctx context.Context, in *SnapshotsInput) (*httpapi.Body[json.RawMessage], error) {
	if in.Projection == "full" {
		return projected(s.db.LibraryCollectionSnapshots(ctx, in.ID))
	}
	return projected(s.db.LibraryCollectionSnapshotSummaries(ctx, in.ID, library.ListOptions{Limit: in.Limit, Offset: in.Offset}))
}

type SnapshotInput struct {
	ID         string `path:"id" doc:"The collection's ID."`
	SnapshotID int64  `path:"snapshotId" minimum:"1" doc:"The snapshot's id, from the list of snapshots."`
}

func (s *Server) libraryCollectionSnapshot(ctx context.Context, in *SnapshotInput) (*httpapi.Body[library.Snapshot], error) {
	return libraryReply(s.db.LibraryCollectionSnapshot(ctx, in.ID, in.SnapshotID))
}

func (s *Server) libraryFiles(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.File], error) {
	o, err := in.options()
	if err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	return libraryList(s.db.ListLibraryFiles(ctx, o))
}

func (s *Server) libraryFile(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[library.File], error) {
	return libraryReply(s.db.LibraryFile(ctx, in.ID))
}

func (s *Server) libraryPage(ctx context.Context, in *LibraryIDInput) (*httpapi.Body[library.Page], error) {
	return libraryReply(s.db.LibraryPage(ctx, in.ID))
}
