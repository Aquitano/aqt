package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"

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

// registerLibraryAPI describes the routes over combined search and the media library.
func (s *Server) registerLibraryAPI(api huma.API) {
	notFound := []httpapi.Kind{httpapi.NotFound}
	edit := []httpapi.Kind{httpapi.NotFound, errRevisionConflict}

	huma.Register(api, httpapi.Operation{ID: "findRecords", Method: http.MethodGet, Path: "/v1/find", Tag: "search",
		Summary: "Search messages, the media library, files and files on disks at once",
		Description: "q is required. Messages are ranked by relevance; library groups are sorted by title or date. " +
			"from, to, person, subject, mailbox_id and has_attachment restrict the search to messages, and cannot " +
			"be combined with a kind other than message or with account. since and until take YYYY-MM-DD here. " +
			"limit and offset apply to each group on its own. coverage says what the result does not prove.",
	}.For(api), s.find)
	huma.Register(api, httpapi.Operation{ID: "searchLibrary", Method: http.MethodGet, Path: "/v1/library/search", Tag: "library",
		Summary: "Search items, activity, collections, files and pages of the media library",
		Description: "kind narrows to one group (item, activity, collection, file, page) or to one kind inside a " +
			"group. limit and offset apply to each group on its own. An absent activity is not evidence that " +
			"something was not watched: only imported records are searched.",
	}.For(api), s.librarySearch)

	huma.Register(api, httpapi.Operation{ID: "listLibraryItems", Method: http.MethodGet, Path: "/v1/library/items", Tag: "library",
		Summary: "List media items (films, episodes, tracks, books and more), sorted by title",
	}.For(api), s.libraryItems)
	huma.Register(api, libraryWrite(httpapi.Operation{ID: "createLibraryItem", Method: http.MethodPost, Path: "/v1/library/items", Tag: "library",
		Summary: "Add a media item by hand",
		Description: "kind and title are required. The server assigns id, source (manual), account and external_id; " +
			"what the body says for them is ignored.",
	}.For(api), http.StatusCreated), s.createLibraryItem)
	huma.Register(api, libraryWrite(httpapi.Operation{ID: "summarizeLibraryItems", Method: http.MethodPost, Path: "/v1/library/items/summaries", Tag: "library",
		Summary:     "Look up the title, kind and source of up to 50 items by ID",
		Description: "Answers in the order the IDs were given, each item once. Unknown IDs are left out.",
	}.For(api), http.StatusOK), s.libraryItemSummaries)
	huma.Register(api, httpapi.Operation{ID: "getLibraryItem", Method: http.MethodGet, Path: "/v1/library/items/{id}", Tag: "library",
		Summary: "Return one media item with its state, evidence and linked files",
		Errors:  notFound,
	}.For(api), s.libraryItem)
	huma.Register(api, libraryWrite(httpapi.Operation{ID: "setLibraryItemState", Method: http.MethodPut, Path: "/v1/library/items/{id}/state", Tag: "library",
		Summary: "Replace an item's personal state: status, rating, progress, notes and tags",
		Description: "The body replaces the whole state, so send every field that should stay. expected_revision is " +
			"the state's revision as last read, 0 for an item whose state was never set.",
		Errors: edit,
	}.For(api), http.StatusOK), s.setLibraryState)
	huma.Register(api, httpapi.Operation{ID: "listLibraryItemStateHistory", Method: http.MethodGet, Path: "/v1/library/items/{id}/state-history", Tag: "library",
		Summary: "List every revision of an item's personal state",
		Errors:  notFound,
	}.For(api), s.libraryStateHistory)

	huma.Register(api, httpapi.Operation{ID: "listLibraryActivity", Method: http.MethodGet, Path: "/v1/library/activity", Tag: "library",
		Summary: "List what was watched, listened to, read, played or bought, newest first",
	}.For(api), s.libraryActivity)
	huma.Register(api, httpapi.Operation{ID: "getLibraryActivity", Method: http.MethodGet, Path: "/v1/library/activity/{id}", Tag: "library",
		Summary: "Return one activity record with its evidence",
		Errors:  notFound,
	}.For(api), s.libraryActivityRecord)

	huma.Register(api, eitherList[library.CollectionSummary, library.Collection](api, httpapi.Operation{ID: "listLibraryCollections", Method: http.MethodGet, Path: "/v1/library/collections", Tag: "library",
		Summary: "List playlists, watchlists and other collections, sorted by title",
		Description: "Each collection carries its current snapshot: with its entry count by default, with the " +
			"entries themselves when projection is full.",
	}.For(api)), s.libraryCollections)
	huma.Register(api, libraryWrite(httpapi.Operation{ID: "createLibraryCollection", Method: http.MethodPost, Path: "/v1/library/collections", Tag: "library",
		Summary: "Create a personal collection",
		Description: "title and kind (playlist, watchlist, library or list) are required. snapshot.entries are the " +
			"first entries. The server assigns id, source (manual), account and external_id.",
	}.For(api), http.StatusCreated), s.createLibraryCollection)
	huma.Register(api, httpapi.Operation{ID: "getLibraryCollection", Method: http.MethodGet, Path: "/v1/library/collections/{id}", Tag: "library",
		Summary: "Return one collection with the entries of its current snapshot",
		Errors:  notFound,
	}.For(api), s.libraryCollection)
	huma.Register(api, libraryWrite(httpapi.Operation{ID: "editLibraryCollection", Method: http.MethodPut, Path: "/v1/library/collections/{id}", Tag: "library",
		Summary: "Replace a personal collection's title, description and entries",
		Description: "Only collections created here can be edited; imported ones are read-only. The body replaces " +
			"all entries. expected_revision is the collection's revision as last read.",
		Errors: edit,
	}.For(api), http.StatusOK), s.editLibraryCollection)
	huma.Register(api, eitherList[library.SnapshotSummary, library.Snapshot](api, httpapi.Operation{ID: "listLibraryCollectionSnapshots", Method: http.MethodGet, Path: "/v1/library/collections/{id}/snapshots", Tag: "library",
		Summary: "List the recorded states of a collection, newest first",
		Description: "By default a page of snapshots with their entry counts. With projection full, every snapshot " +
			"with its entries, and limit and offset are ignored.",
		Errors: notFound,
	}.For(api)), s.libraryCollectionSnapshots)
	huma.Register(api, httpapi.Operation{ID: "getLibraryCollectionSnapshot", Method: http.MethodGet, Path: "/v1/library/collections/{id}/snapshots/{snapshotId}", Tag: "library",
		Summary: "Return one recorded state of a collection with its entries",
		Errors:  notFound,
	}.For(api), s.libraryCollectionSnapshot)

	huma.Register(api, httpapi.Operation{ID: "listLibraryFiles", Method: http.MethodGet, Path: "/v1/library/files", Tag: "library",
		Summary:     "List the files kept in the library, sorted by filename",
		Description: "q also searches the text read from the files. kind does not apply to files.",
	}.For(api), s.libraryFiles)
	huma.Register(api, httpapi.Operation{ID: "getLibraryFile", Method: http.MethodGet, Path: "/v1/library/files/{id}", Tag: "library",
		Summary: "Return one library file's record. Its bytes are at /v1/blobs/{sha256}",
		Errors:  notFound,
	}.For(api), s.libraryFile)
	huma.Register(api, httpapi.Operation{ID: "getLibraryPage", Method: http.MethodGet, Path: "/v1/library/pages/{id}", Tag: "library",
		Summary: "Return one published note with its body",
		Errors:  notFound,
	}.For(api), s.libraryPage)
}

// The older library routes took 32 MiB of JSON, required no field and
// refused unknown ones. libraryWrite and strictJSON keep all three.
func libraryWrite(op huma.Operation, status int) huma.Operation {
	op.DefaultStatus, op.MaxBodyBytes, op.SkipValidateBody = status, 32<<20, true
	return op
}

type strictJSON[T any] struct{ Value T }

func (b *strictJSON[T]) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(&b.Value)
}

func (strictJSON[T]) Schema(r huma.Registry) *huma.Schema {
	schema := *huma.SchemaFromType(r, reflect.TypeFor[T]())
	schema.Required = nil
	return &schema
}

// eitherList documents a route whose projection parameter picks between two list shapes.
func eitherList[Summary, Full any](api huma.API, op huma.Operation) huma.Operation {
	schemas := api.OpenAPI().Components.Schemas
	op.Responses["200"] = &huma.Response{Description: http.StatusText(http.StatusOK), Content: map[string]*huma.MediaType{
		"application/json": {Schema: &huma.Schema{OneOf: []*huma.Schema{
			schemas.Schema(reflect.TypeFor[[]Summary](), true, ""),
			schemas.Schema(reflect.TypeFor[[]Full](), true, ""),
		}}},
	}}
	return op
}

func libraryError(err error) error {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		switch {
		case strings.HasPrefix(pgErr.Code, "22"), pgErr.Code == "54000":
			return httpapi.Invalid.New(pgErr.Message)
		case pgErr.Code == "23503", pgErr.Code == "23514":
			return httpapi.Invalid.New("invalid library record or missing linked item")
		}
	}
	switch {
	case errors.Is(err, library.ErrConflict):
		return errRevisionConflict.New("This record changed. Reload it before saving again.").With("code", "library_revision_conflict")
	case errors.Is(err, catalog.ErrFilters), errors.Is(err, library.ErrReadOnly), errors.Is(err, library.ErrInvalid):
		return invalid(err)
	case errors.Is(err, store.ErrNotFound):
		return httpapi.NotFound.New("library record not found")
	}
	return internal(err)
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
	Limit   int    `query:"limit" default:"50" minimum:"0" maximum:"500" doc:"0 means 50."`
	Offset  int    `query:"offset" default:"0" minimum:"0" maximum:"100000"`
}

func (f LibraryFilters) options() (library.ListOptions, error) {
	o := library.ListOptions{Query: f.Q, Match: f.Match, Source: f.Source, Account: f.Account, Kind: f.Kind,
		ItemID: f.ItemID, Since: f.Since, Until: f.Until, Limit: f.Limit, Offset: f.Offset}
	return o, o.Validate()
}

type libraryIDInput struct {
	ID string `path:"id" doc:"The record's ID, such as item_… or file_…."`
}

type findInput struct {
	LibraryFilters
	From          string `query:"from" doc:"Message sender contains this, ignoring case."`
	To            string `query:"to" doc:"A message recipient contains this, ignoring case."`
	Person        string `query:"person" doc:"Messages sent or received by this contact, by name."`
	Subject       string `query:"subject" doc:"Message subject contains this, ignoring case."`
	Fuzzy         int    `query:"fuzzy" default:"1" minimum:"0" maximum:"2" doc:"Typos tolerated per word in messages."`
	MailboxID     int64  `query:"mailbox_id" minimum:"1" doc:"Only this mail folder. Needs source."`
	HasAttachment string `query:"has_attachment" enum:"true,false" doc:"Only messages with, or without, attachments."`
}

func (s *Server) find(ctx context.Context, in *findInput) (*httpapi.Body[catalog.Result], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	messages := store.SearchOpts{Source: o.Source, From: in.From, To: in.To, Person: in.Person, Subject: in.Subject,
		Match: in.Match, Fuzzy: in.Fuzzy, Limit: cmp.Or(o.Limit, 50), Offset: o.Offset, MailboxID: in.MailboxID}
	if in.MailboxID != 0 && in.Source == "" {
		return nil, httpapi.Invalid.New("mailbox_id requires a source")
	}
	if in.HasAttachment != "" {
		has := in.HasAttachment == "true"
		messages.HasAttachment = &has
	}
	if messages.Since, err = parseDate(in.Since); err != nil {
		return nil, invalid(err)
	}
	if messages.Until, err = parseDate(in.Until); err != nil {
		return nil, invalid(err)
	}
	if err = messages.ValidateQuery(o.Query); err != nil {
		return nil, invalid(err)
	}
	// A nil catalogue must reach Find as a nil interface.
	var disks catalog.Disks
	if s.catalogue != nil {
		disks = s.catalogue
	}
	result, err := catalog.Find(ctx, s.db, disks, o.Query, messages, o)
	if _, noContact := errors.AsType[*store.ErrNoContact](err); noContact || errors.Is(err, store.ErrMailboxSource) {
		return nil, invalid(err)
	}
	return libraryReply(result, err)
}

// Schemas are named after their Go type, and the result of a search over disks
// is a SearchResult too.
type librarySearchResult library.SearchResult

func (s *Server) librarySearch(ctx context.Context, in *LibraryFilters) (*httpapi.Body[librarySearchResult], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	result, err := s.db.SearchLibrary(ctx, o)
	return libraryReply(librarySearchResult(result), err)
}

func (s *Server) libraryItems(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.Item], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	return libraryList(s.db.ListLibraryItems(ctx, o))
}

func (s *Server) createLibraryItem(ctx context.Context, in *struct {
	Body strictJSON[library.Item]
}) (*httpapi.Body[library.Item], error) {
	item := in.Body.Value
	item.Identity = newManualIdentity()
	item.ID = library.StableID("item", item.Identity)
	batch := library.ImportBatch{Version: 1, Items: []library.Item{item}}
	if err := batch.Validate(); err != nil {
		return nil, invalid(err)
	}
	if _, err := s.db.ImportLibrary(ctx, batch); err != nil {
		return nil, libraryError(err)
	}
	return libraryReply(s.db.LibraryItem(ctx, item.ID))
}

func (s *Server) libraryItemSummaries(ctx context.Context, in *struct {
	Body strictJSON[library.ItemSummaryRequest]
}) (*httpapi.Body[[]library.ItemSummary], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, invalid(err)
	}
	return libraryList(s.db.LibraryItemSummaries(ctx, in.Body.Value.IDs))
}

func (s *Server) libraryItem(ctx context.Context, in *libraryIDInput) (*httpapi.Body[library.Item], error) {
	return libraryReply(s.db.LibraryItem(ctx, in.ID))
}

func (s *Server) setLibraryState(ctx context.Context, in *struct {
	ID   string `path:"id" doc:"The item's ID."`
	Body strictJSON[library.StateEdit]
}) (*httpapi.Body[library.State], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, invalid(err)
	}
	return libraryReply(s.db.SetLibraryState(ctx, in.ID, in.Body.Value))
}

func (s *Server) libraryStateHistory(ctx context.Context, in *libraryIDInput) (*httpapi.Body[[]library.State], error) {
	return libraryList(s.db.LibraryStateHistory(ctx, in.ID))
}

func (s *Server) libraryActivity(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.Activity], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	return libraryList(s.db.ListLibraryActivity(ctx, o))
}

func (s *Server) libraryActivityRecord(ctx context.Context, in *libraryIDInput) (*httpapi.Body[library.Activity], error) {
	return libraryReply(s.db.LibraryActivity(ctx, in.ID))
}

func (s *Server) libraryCollections(ctx context.Context, in *struct {
	LibraryFilters
	Projection string `query:"projection" enum:"summary,full" doc:"full answers with every snapshot's entries, where the default has their count."`
}) (*httpapi.Body[any], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	if in.Projection == "full" {
		return libraryReply[any](s.db.ListLibraryCollections(ctx, o))
	}
	return libraryReply[any](s.db.ListLibraryCollectionSummaries(ctx, o))
}

func (s *Server) createLibraryCollection(ctx context.Context, in *struct {
	Body strictJSON[library.Collection]
}) (*httpapi.Body[library.Collection], error) {
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
		return nil, invalid(err)
	}
	return libraryReply(s.db.CreateLibraryCollection(ctx, collection))
}

func (s *Server) libraryCollection(ctx context.Context, in *libraryIDInput) (*httpapi.Body[library.Collection], error) {
	return libraryReply(s.db.LibraryCollection(ctx, in.ID))
}

func (s *Server) editLibraryCollection(ctx context.Context, in *struct {
	ID   string `path:"id" doc:"The collection's ID."`
	Body strictJSON[library.CollectionEdit]
}) (*httpapi.Body[library.Collection], error) {
	if err := in.Body.Value.Validate(); err != nil {
		return nil, invalid(err)
	}
	return libraryReply(s.db.EditLibraryCollection(ctx, in.ID, in.Body.Value))
}

func (s *Server) libraryCollectionSnapshots(ctx context.Context, in *struct {
	ID         string `path:"id" doc:"The collection's ID."`
	Projection string `query:"projection" enum:"summary,full" doc:"full answers with every snapshot's entries, where the default has their count."`
	Limit      int    `query:"limit" default:"50" minimum:"0" maximum:"500" doc:"0 means 50."`
	Offset     int    `query:"offset" default:"0" minimum:"0" maximum:"100000"`
}) (*httpapi.Body[any], error) {
	if in.Projection == "full" {
		return libraryReply[any](s.db.LibraryCollectionSnapshots(ctx, in.ID))
	}
	return libraryReply[any](s.db.LibraryCollectionSnapshotSummaries(ctx, in.ID, library.ListOptions{Limit: in.Limit, Offset: in.Offset}))
}

func (s *Server) libraryCollectionSnapshot(ctx context.Context, in *struct {
	ID         string `path:"id" doc:"The collection's ID."`
	SnapshotID int64  `path:"snapshotId" minimum:"1" doc:"The snapshot's id, from the list of snapshots."`
}) (*httpapi.Body[library.Snapshot], error) {
	return libraryReply(s.db.LibraryCollectionSnapshot(ctx, in.ID, in.SnapshotID))
}

func (s *Server) libraryFiles(ctx context.Context, in *LibraryFilters) (*httpapi.Body[[]library.File], error) {
	o, err := in.options()
	if err != nil {
		return nil, invalid(err)
	}
	return libraryList(s.db.ListLibraryFiles(ctx, o))
}

func (s *Server) libraryFile(ctx context.Context, in *libraryIDInput) (*httpapi.Body[library.File], error) {
	return libraryReply(s.db.LibraryFile(ctx, in.ID))
}

func (s *Server) libraryPage(ctx context.Context, in *libraryIDInput) (*httpapi.Body[library.Page], error) {
	return libraryReply(s.db.LibraryPage(ctx, in.ID))
}
