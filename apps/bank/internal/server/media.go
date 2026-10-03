package server

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Server) registerLibraryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/find", s.handleFind)
	mux.HandleFunc("GET /v1/library/search", s.handleMediaSearch)
	mux.HandleFunc("GET /v1/library/items", s.handleMediaItems)
	mux.HandleFunc("POST /v1/library/items", s.handleMediaCreate)
	mux.HandleFunc("GET /v1/library/items/{id}", s.handleMediaItem)
	mux.HandleFunc("PUT /v1/library/items/{id}/state", s.handleMediaState)
	mux.HandleFunc("GET /v1/library/activity", s.handleMediaActivity)
	mux.HandleFunc("GET /v1/library/collections", s.handleMediaCollections)
	mux.HandleFunc("POST /v1/library/collections", s.handleCollectionCreate)
	mux.HandleFunc("GET /v1/library/collections/{id}", s.handleCollection)
	mux.HandleFunc("GET /v1/library/collections/{id}/snapshots", s.handleCollectionSnapshots)
	mux.HandleFunc("PUT /v1/library/collections/{id}", s.handleCollectionEdit)
	mux.HandleFunc("GET /v1/library/files", s.handleMediaFiles)
	mux.HandleFunc("POST /v1/library/files", s.handleFileUpload)
	mux.HandleFunc("GET /v1/library/files/{id}", s.handleMediaFile)
	mux.HandleFunc("GET /v1/library/pages/{id}", s.handleMediaPage)
	mux.HandleFunc("POST /v1/library/pages/publication", s.handlePagePublication)
	mux.HandleFunc("GET /v1/library/items/{id}/state-history", s.handleStateHistory)
}

func parseLibraryOptions(r *http.Request) (library.ListOptions, error) {
	q := r.URL.Query()
	o := library.ListOptions{Query: q.Get("q"), Match: q.Get("match"), Source: q.Get("source"), Account: q.Get("account"), Kind: q.Get("kind"), ItemID: q.Get("item_id"), Since: q.Get("since"), Until: q.Get("until"), Limit: 50}
	var err error
	if o.Limit, err = parseInt(q.Get("limit"), 50); err != nil {
		return o, fmt.Errorf("invalid limit")
	}
	if o.Offset, err = parseInt(q.Get("offset"), 0); err != nil {
		return o, fmt.Errorf("invalid offset")
	}
	return o, o.Validate()
}

func decodeLibraryJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeErr(w, 400, "invalid request: "+err.Error())
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeErr(w, 400, "expected one JSON value")
		return false
	}
	return true
}

func libraryFailure(w http.ResponseWriter, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "23503" || pgErr.Code == "23514") {
		writeErr(w, 400, "invalid library record or missing linked item")
		return
	}
	switch {
	case errors.Is(err, library.ErrConflict):
		writeJSON(w, 409, map[string]string{"code": "library_revision_conflict", "error": "This record changed. Reload it before saving again."})
	case errors.Is(err, catalog.ErrFilters):
		writeErr(w, 400, err.Error())
	case errors.Is(err, library.ErrReadOnly):
		writeErr(w, 400, err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, 404, "library record not found")
	default:
		writeErr(w, 500, err.Error())
	}
}

func newManualIdentity() library.Identity {
	return library.Identity{Source: "manual", Account: "owner", ExternalID: rand.Text()}
}

func (s *Server) handleMediaItems(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows, err := s.db.ListLibraryItems(r.Context(), o)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleMediaCreate(w http.ResponseWriter, r *http.Request) {
	var item library.Item
	if !decodeLibraryJSON(w, r, &item) {
		return
	}
	item.Identity = newManualIdentity()
	item.ID = library.StableID("item", item.Identity)
	batch := library.ImportBatch{Version: 1, Items: []library.Item{item}}
	if err := batch.Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if _, err := s.db.ImportLibrary(r.Context(), batch); err != nil {
		libraryFailure(w, err)
		return
	}
	row, err := s.db.LibraryItem(r.Context(), item.ID)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 201, row)
}

func (s *Server) handleMediaItem(w http.ResponseWriter, r *http.Request) {
	row, err := s.db.LibraryItem(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleMediaState(w http.ResponseWriter, r *http.Request) {
	var edit library.StateEdit
	if !decodeLibraryJSON(w, r, &edit) {
		return
	}
	if err := edit.Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	row, err := s.db.SetLibraryState(r.Context(), r.PathValue("id"), edit)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleMediaActivity(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows, err := s.db.ListLibraryActivity(r.Context(), o)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleMediaCollections(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows, err := s.db.ListLibraryCollections(r.Context(), o)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleCollectionCreate(w http.ResponseWriter, r *http.Request) {
	var collection library.Collection
	if !decodeLibraryJSON(w, r, &collection) {
		return
	}
	collection.Identity = newManualIdentity()
	collection.ID = library.StableID("collection", collection.Identity)
	collection.Personal = true
	if strings.TrimSpace(collection.Title) == "" {
		writeErr(w, 400, "title is required")
		return
	}
	if collection.Kind != "playlist" && collection.Kind != "watchlist" && collection.Kind != "library" && collection.Kind != "list" {
		writeErr(w, 400, "invalid collection kind")
		return
	}
	entries := []library.Entry{}
	if collection.Snapshot != nil {
		entries = collection.Snapshot.Entries
	}
	if err := (library.CollectionEdit{Title: collection.Title, Entries: entries}).Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	row, err := s.db.CreateLibraryCollection(r.Context(), collection)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 201, row)
}

func (s *Server) handleCollection(w http.ResponseWriter, r *http.Request) {
	row, err := s.db.LibraryCollection(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleCollectionSnapshots(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.LibraryCollectionSnapshots(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleCollectionEdit(w http.ResponseWriter, r *http.Request) {
	var edit library.CollectionEdit
	if !decodeLibraryJSON(w, r, &edit) {
		return
	}
	if err := edit.Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	row, err := s.db.EditLibraryCollection(r.Context(), r.PathValue("id"), edit)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleMediaFiles(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows, err := s.db.ListLibraryFiles(r.Context(), o)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleMediaFile(w http.ResponseWriter, r *http.Request) {
	row, err := s.db.LibraryFile(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	reader, err := r.MultipartReader()
	if err != nil {
		writeErr(w, 400, "expected multipart files")
		return
	}
	source, account, itemID := r.URL.Query().Get("source"), r.URL.Query().Get("account"), r.URL.Query().Get("item_id")
	files := []library.File{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		if part.FileName() == "" {
			value, err := io.ReadAll(io.LimitReader(part, 4097))
			part.Close()
			if err != nil || len(value) > 4096 {
				writeErr(w, 400, "invalid upload field")
				return
			}
			switch part.FormName() {
			case "source":
				source = string(value)
			case "account":
				account = string(value)
			case "item_id":
				itemID = string(value)
			default:
				writeErr(w, 400, "unknown upload field")
				return
			}
			continue
		}
		if part.FormName() != "file" && part.FormName() != "files" {
			part.Close()
			writeErr(w, 400, "expected file field")
			return
		}
		if len(files) >= 100 {
			part.Close()
			writeErr(w, 400, "at most 100 files per upload")
			return
		}
		filename := filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
		if filename == "." || filename == "" {
			part.Close()
			writeErr(w, 400, "invalid filename")
			return
		}
		buffer := bufio.NewReader(part)
		head, _ := buffer.Peek(512)
		mimeType := mime.TypeByExtension(filepath.Ext(filename))
		if mimeType == "" {
			mimeType = http.DetectContentType(head)
		}
		sum, size, err := s.blobs.Put(buffer)
		part.Close()
		if err != nil {
			writeErr(w, 400, "file upload: "+err.Error())
			return
		}
		files = append(files, library.File{SHA256: sum, Filename: filename, MimeType: mimeType, SizeBytes: size, ItemIDs: []string{}})
	}
	if len(files) == 0 {
		writeErr(w, 400, "at least one file is required")
		return
	}
	if source == "" {
		source = "files"
	}
	if account == "" {
		account = "owner"
	}
	if err := archive.ValidSource(source); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if itemID != "" {
		if _, err := s.db.LibraryItem(r.Context(), itemID); err != nil {
			libraryFailure(w, err)
			return
		}
	}
	for i := range files {
		files[i].Identity = library.Identity{Source: source, Account: account, ExternalID: files[i].SHA256 + ":" + files[i].Filename}
		files[i].ID = library.StableID("file", files[i].Identity)
		if itemID != "" {
			files[i].ItemIDs = []string{itemID}
		}
	}
	batch := library.ImportBatch{Version: 1, Files: files}
	if err := batch.Validate(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if _, err := s.db.ImportLibrary(r.Context(), batch); err != nil {
		libraryFailure(w, err)
		return
	}
	s.extractAfterImport(r.Context())
	for i := range files {
		row, err := s.db.LibraryFile(r.Context(), files[i].ID)
		if err != nil {
			libraryFailure(w, err)
			return
		}
		files[i] = row
	}
	writeJSON(w, 201, files)
}

func (s *Server) handleMediaPage(w http.ResponseWriter, r *http.Request) {
	row, err := s.db.LibraryPage(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, row)
}

func (s *Server) handleMediaSearch(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	rows, err := s.db.SearchLibrary(r.Context(), o)
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handleStateHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.LibraryStateHistory(r.Context(), r.PathValue("id"))
	if err != nil {
		libraryFailure(w, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handlePagePublication(w http.ResponseWriter, r *http.Request) {
	var publication mediaimport.Publication
	if !decodeLibraryJSON(w, r, &publication) {
		return
	}
	result, err := mediaimport.Publish(r.Context(), s.db, s.archiveDir, publication)
	if err != nil {
		writeCause(w, err)
		return
	}
	writeJSON(w, 200, result)
}

func (s *Server) handleFind(w http.ResponseWriter, r *http.Request) {
	o, err := parseLibraryOptions(r)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	query := r.URL.Query()
	messageOpts := store.SearchOpts{Source: o.Source, From: query.Get("from"), To: query.Get("to"), Person: query.Get("person"), Match: query.Get("match"), Fuzzy: 1, Limit: o.Limit, Offset: o.Offset}
	if messageOpts.Limit == 0 {
		messageOpts.Limit = 50
	}
	if messageOpts.MailboxID, messageOpts.Subject, messageOpts.HasAttachment, err = parseMailFilters(query); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if messageOpts.Since, err = parseDate(query.Get("since")); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if messageOpts.Until, err = parseDate(query.Get("until")); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if messageOpts.Fuzzy, err = parseInt(query.Get("fuzzy"), 1); err != nil {
		writeErr(w, 400, "invalid fuzzy")
		return
	}
	if err = messageOpts.ValidateQuery(o.Query); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	result, err := catalog.Find(r.Context(), s.db, o.Query, messageOpts, o)
	if err != nil {
		var missing *store.ErrNoContact
		if errors.Is(err, store.ErrMailboxSource) || errors.As(err, &missing) {
			writeErr(w, 400, err.Error())
		} else {
			libraryFailure(w, err)
		}
		return
	}
	writeJSON(w, 200, result)
}
