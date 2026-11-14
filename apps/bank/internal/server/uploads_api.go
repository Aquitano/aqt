package server

import (
	"bufio"
	"cmp"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// maxUploadFiles bounds one library upload.
const maxUploadFiles = 100

var UploadLibraryFiles = httpapi.Op[UploadLibraryFilesInput, []library.File]{Operation: httpapi.Operation{ID: "uploadLibraryFiles", Method: http.MethodPost, Path: "/v1/library/files", Tag: "library",
	Summary: "Keep up to 100 files in the library",
	Description: "multipart/form-data with one file or files field per file, up to 16 GiB in all. The query " +
		"parameters are checked before any bytes are stored.",
	Errors: []httpapi.Kind{httpapi.NotFound},
	Writes: true,
}}

// registerUploadsAPI serves the routes that take files: imports, library
// file uploads and page publications.
func (s *Server) registerUploadsAPI(api huma.API) {
	for _, kind := range s.kinds {
		s.registerImport(api, kind)
	}
	httpapi.Register(api, UploadLibraryFiles, s.uploadLibraryFiles, func(op *huma.Operation) {
		op.DefaultStatus = http.StatusCreated
	}).RequestBody = &huma.RequestBody{Required: true, Content: map[string]*huma.MediaType{
		"multipart/form-data": {Schema: &huma.Schema{Type: "object", Properties: map[string]*huma.Schema{
			"file": {Type: "array", Items: &huma.Schema{Type: "string", Format: "binary"}},
		}}},
	}}
}

// ImportOp is the import operation of one kind.
func ImportOp(kind importer.Kind) httpapi.Op[ImportInput, store.RawInput] {
	return httpapi.Op[ImportInput, store.RawInput]{Operation: httpapi.Operation{ID: "import" + exportedName(kind.Name), Method: http.MethodPost, Path: "/v1/import/" + kind.Name, Tag: "imports",
		Summary: kind.Help,
		Description: "multipart/form-data with an optional options field, the kind's options as JSON, followed by the " +
			"file field, up to 16 GiB. The input is stored as a raw input before it is parsed, and the answer is that " +
			"raw input with the report of this import. An input the parser rejects stays stored, and the rejection " +
			"is an InvalidRequest; `bank reimport` replays it once the parser reads it.",
		Writes: true,
	}}
}

// registerImport serves one kind's import route. Its options field has the
// kind's own options schema.
func (s *Server) registerImport(api huma.API, kind importer.Kind) {
	registered := httpapi.Register(api, ImportOp(kind), func(ctx context.Context, in *ImportInput) (*httpapi.Body[store.RawInput], error) {
		return s.importInput(ctx, kind, in)
	})
	// Every source names its type Options, so the schema is inlined from a
	// registry of its own instead of named in the document's.
	options := huma.NewMapRegistry("#/components/schemas/", huma.DefaultSchemaNamer).Schema(kind.Options, false, "")
	registered.RequestBody = &huma.RequestBody{Required: true, Content: map[string]*huma.MediaType{
		"multipart/form-data": {Schema: &huma.Schema{Type: "object", Required: []string{"file"}, Properties: map[string]*huma.Schema{
			"options": options,
			"file":    {Type: "string", Format: "binary", Description: "The input, as one file. A directory is sent as a zip of it."},
		}}},
	}}
}

// exportedName turns a kind such as youtube-media into YoutubeMedia.
func exportedName(kind string) string {
	var b strings.Builder
	for _, word := range strings.FieldsFunc(kind, func(r rune) bool { return r == '-' || r == '_' }) {
		b.WriteString(strings.ToUpper(word[:1]) + word[1:])
	}
	return b.String()
}

type ImportInput struct {
	httpapi.Stream
}

// imports bounds the imports that parse at once, for every kind: parsers
// hold records, mail and attachments in memory, and the container has 2 GiB.
// Storing an upload's bytes streams to disk and does not wait for a slot.
var imports = make(chan struct{}, 2)

// maxOptions bounds the options field, which is read into memory.
const maxOptions = 64 << 10

func (s *Server) importInput(ctx context.Context, kind importer.Kind, in *ImportInput) (*httpapi.Body[store.RawInput], error) {
	parts, err := in.Multipart(maxUpload)
	if err != nil {
		return nil, err
	}
	target := importer.Target{Store: s.db, Blobs: s.blobs, Kinds: s.kinds}
	var options json.RawMessage
	var id int64
	for id == 0 {
		part, err := parts.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, httpapi.Invalid.New("no file field in upload")
		}
		if err != nil {
			return nil, cmp.Or(in.Failed(), error(httpapi.Invalid.New("malformed multipart body: "+err.Error())))
		}
		switch part.FormName() {
		case "options":
			if options != nil {
				return nil, httpapi.Invalid.New("duplicate options field")
			}
			if options, err = io.ReadAll(io.LimitReader(part, maxOptions+1)); err != nil {
				return nil, cmp.Or(in.Failed(), error(httpapi.Invalid.New("reading options: "+err.Error())))
			}
			if len(options) > maxOptions {
				return nil, httpapi.Invalid.New("options are larger than 64 KiB")
			}
		case "file":
			name := filepath.Base(filepath.FromSlash(strings.ReplaceAll(part.FileName(), "\\", "/")))
			id, err = importer.Store(ctx, target, kind.Name, name, part, options)
			if err != nil {
				return nil, cmp.Or(in.Failed(), importFailure(err))
			}
		}
		part.Close()
	}
	if _, err := parts.NextPart(); !errors.Is(err, io.EOF) {
		return nil, cmp.Or(in.Failed(), error(httpapi.Invalid.New("file must be the final multipart field")))
	}
	select {
	case imports <- struct{}{}:
		defer func() { <-imports }()
	case <-ctx.Done():
		return nil, internal(ctx.Err())
	}
	raw, err := importer.Run(ctx, target, id)
	if err != nil {
		return nil, importFailure(err)
	}
	return &httpapi.Body[store.RawInput]{Body: raw}, nil
}

// importFailure classifies an import's error by the importer's contract: a
// failing database, disk or context is marked with fail.Op, and anything
// else is the input's. A failure of the server is answered without its
// cause.
func importFailure(err error) error {
	if fail.IsOp(err) {
		return internal(err)
	}
	return httpapi.Invalid.New(err.Error())
}

type UploadLibraryFilesInput struct {
	Source  string `query:"source" maxLength:"4096" doc:"The source the files are filed under. Default: files."`
	Account string `query:"account" maxLength:"4096" doc:"The account at the source. Default: owner."`
	ItemID  string `query:"item_id" doc:"Link every file to this library item, which must exist."`
	httpapi.Stream
}

// uploadLibraryFiles checks everything the request names before it stores a
// byte, so a refused upload leaves no blob that nothing refers to.
func (s *Server) uploadLibraryFiles(ctx context.Context, in *UploadLibraryFilesInput) (*httpapi.Body[[]library.File], error) {
	source, account := cmp.Or(in.Source, "files"), cmp.Or(in.Account, "owner")
	if err := ingest.ValidSource(source); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if strings.ContainsRune(account, 0) {
		return nil, httpapi.Invalid.New("account must not contain NUL")
	}
	if in.ItemID != "" {
		if _, err := s.db.LibraryItem(ctx, in.ItemID); err != nil {
			return nil, libraryError(err)
		}
	}
	parts, err := in.Multipart(maxUpload)
	if err != nil {
		return nil, err
	}
	files := []library.File{}
	for {
		part, err := parts.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, cmp.Or(in.Failed(), error(httpapi.Invalid.New("malformed multipart body: "+err.Error())))
		}
		file, err := s.storeUploadedFile(ctx, part, len(files))
		part.Close()
		if err != nil {
			return nil, cmp.Or(in.Failed(), err)
		}
		files = append(files, file)
	}
	if len(files) == 0 {
		return nil, httpapi.Invalid.New("at least one file is required")
	}
	for i := range files {
		files[i].Identity = library.Identity{Source: source, Account: account, ExternalID: files[i].BLAKE3.String() + ":" + files[i].Filename}
		files[i].ID = library.StableID("file", files[i].Identity)
		if in.ItemID != "" {
			files[i].ItemIDs = []string{in.ItemID}
		}
	}
	batch := library.ImportBatch{Version: 1, Files: files}
	if err := batch.Validate(); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if _, err := s.db.ImportLibrary(ctx, batch); err != nil {
		return nil, libraryError(err)
	}
	for i := range files {
		row, err := s.db.LibraryFile(ctx, files[i].ID)
		if err != nil {
			return nil, libraryError(err)
		}
		files[i] = row
	}
	return &httpapi.Body[[]library.File]{Body: files}, nil
}

// storeUploadedFile stores one part's bytes. A part that is not a file is
// refused before anything is written.
func (s *Server) storeUploadedFile(ctx context.Context, part *multipart.Part, stored int) (library.File, error) {
	if (part.FormName() != "file" && part.FormName() != "files") || part.FileName() == "" {
		return library.File{}, httpapi.Invalid.New("every part must be a file in a file or files field")
	}
	if stored >= maxUploadFiles {
		return library.File{}, httpapi.Invalid.New("at most 100 files per upload")
	}
	filename := filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
	if filename == "." || filename == "/" {
		return library.File{}, httpapi.Invalid.New("invalid filename")
	}
	buffer := bufio.NewReader(part)
	head, _ := buffer.Peek(512)
	mimeType := mime.TypeByExtension(filepath.Ext(filename))
	if mimeType == "" {
		mimeType = http.DetectContentType(head)
	}
	sum, size, err := s.blobs.Put(ctx, buffer)
	if err != nil {
		return library.File{}, internal(err)
	}
	return library.File{BLAKE3: sum, Filename: filename, MimeType: mimeType, SizeBytes: size, ItemIDs: []string{}}, nil
}

func newManualIdentity() library.Identity {
	return library.Identity{Source: "manual", Account: "owner", ExternalID: rand.Text()}
}
