package server

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s *Server) registerLibraryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/library/files", s.handleFileUpload)
	mux.HandleFunc("POST /v1/library/pages/publication", s.handlePagePublication)
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
	if errors.As(err, &pgErr) && (strings.HasPrefix(pgErr.Code, "22") || pgErr.Code == "54000") {
		writeErr(w, 400, pgErr.Message)
		return
	}
	if errors.As(err, &pgErr) && (pgErr.Code == "23503" || pgErr.Code == "23514") {
		writeErr(w, 400, "invalid library record or missing linked item")
		return
	}
	switch {
	case errors.Is(err, library.ErrConflict):
		writeJSON(w, 409, map[string]string{"code": "library_revision_conflict", "error": "This record changed. Reload it before saving again."})
	case errors.Is(err, catalog.ErrFilters):
		writeErr(w, 400, err.Error())
	case errors.Is(err, library.ErrReadOnly), errors.Is(err, library.ErrInvalid):
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

func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	received := time.Now()
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
	s.extractAfterImport(received)
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
