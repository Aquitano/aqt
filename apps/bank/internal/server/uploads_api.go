package server

import (
	"bufio"
	"cmp"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

// maxUploadFiles bounds one library upload.
const maxUploadFiles = 100

// registerUploadsAPI describes the routes that take files: imports, library
// file uploads and page publications.
func (s *Server) registerUploadsAPI(api huma.API) {
	imports := httpapi.Operation{ID: "importFile", Method: http.MethodPost, Path: "/v1/import/{kind}", Tag: "imports",
		Summary: "Import one export file into the archive",
		Description: "kind is whatsapp, eml, mbox, discord, linkedin, youtube, chatgpt, claude, json, netflix, " +
			"youtube-media or library. Every kind except json takes multipart/form-data whose last field is file, " +
			"up to 16 GiB; eml and mbox may send a mail_context field before it. json takes the records as the " +
			"body, a JSON array or NDJSON of at most 16 MiB that must arrive within a minute. The answer is the " +
			"importer's report, and the attempt is kept in listImportReports. A file the importer cannot read is " +
			"an InvalidRequest.",
		Writes: true,
	}.For(api)
	imports.Responses["200"] = &huma.Response{Description: "The importer's report; its fields depend on kind.",
		Content: map[string]*huma.MediaType{"application/json": {Schema: &huma.Schema{Type: "object"}}}}
	huma.Register(api, imports, s.importFile)
	httpapi.Registered(api, imports.Method, imports.Path).RequestBody = &huma.RequestBody{Required: true, Content: map[string]*huma.MediaType{
		"multipart/form-data": {Schema: &huma.Schema{Type: "object", Required: []string{"file"}, Properties: map[string]*huma.Schema{
			"mail_context": {Type: "string", Description: "eml and mbox only: the folder and identifiers the collector observed, as JSON."},
			"file":         {Type: "string", Format: "binary", Description: "The export, as one file."},
		}}},
		"application/json": {Schema: &huma.Schema{Description: "json only: the records."}},
	}}

	upload := httpapi.Operation{ID: "uploadLibraryFiles", Method: http.MethodPost, Path: "/v1/library/files", Tag: "library",
		Summary: "Keep up to 100 files in the library",
		Description: "multipart/form-data with one file or files field per file, up to 16 GiB in all. The query " +
			"parameters are checked before any bytes are stored.",
		Errors: []httpapi.Kind{httpapi.NotFound},
		Writes: true,
	}.For(api)
	upload.DefaultStatus = http.StatusCreated
	huma.Register(api, upload, s.uploadLibraryFiles)
	httpapi.Registered(api, upload.Method, upload.Path).RequestBody = &huma.RequestBody{Required: true, Content: map[string]*huma.MediaType{
		"multipart/form-data": {Schema: &huma.Schema{Type: "object", Properties: map[string]*huma.Schema{
			"file": {Type: "array", Items: &huma.Schema{Type: "string", Format: "binary"}},
		}}},
	}}

	huma.Register(api, libraryBody(httpapi.Operation{ID: "publishLibraryPages", Method: http.MethodPost, Path: "/v1/library/pages/publication", Tag: "library",
		Summary:     "Publish Markdown pages with the original files they were read from",
		Description: "`bank library index` builds the body. Each page must match its original's bytes and metadata.",
		Writes:      true,
	}.For(api), http.StatusOK), s.publishLibraryPages)
}

type importInput struct {
	Kind      string `path:"kind" doc:"The importer, such as whatsapp, mbox or json."`
	Source    string `query:"source" doc:"The source to file messages under, for kinds that take one, such as eml."`
	Account   string `query:"account" doc:"The account at the source, for media and library kinds."`
	DateOrder string `query:"date_order" enum:"mdy,dmy" doc:"netflix only: how the export writes dates."`
	httpapi.Stream
}

// Uploads are always single files: directory inputs stay a client concern, the
// CLI walks them and posts one file per request.
func (s *Server) importFile(ctx context.Context, in *importInput) (*httpapi.Body[any], error) {
	received := time.Now()
	if err := importer.Check(in.Kind); err != nil {
		return nil, httpapi.Invalid.New(err.Error())
	}
	if in.DateOrder != "" && in.Kind != "netflix" {
		return nil, httpapi.Invalid.New("date_order requires a Netflix import")
	}
	// The source names a directory under the archive root and arrives here
	// straight from a query string, so it is checked before any bytes are
	// written rather than deep inside an importer.
	if in.Source != "" {
		if err := archive.ValidSource(in.Source); err != nil {
			return nil, httpapi.Invalid.New(err.Error())
		}
	}
	var res any
	var err error
	if in.Kind == "json" {
		res, err = s.importJSONBody(ctx, in)
	} else {
		res, err = s.importUpload(ctx, in)
	}
	if err != nil {
		return nil, err
	}
	s.extractAfterImport(received)
	return &httpapi.Body[any]{Body: res}, nil
}

func (s *Server) importJSONBody(ctx context.Context, in *importInput) (any, error) {
	if in.ContentLength() > maxJSONUpload {
		return nil, httpapi.Invalid.New("a JSON import is at most 16 MiB")
	}
	select {
	case jsonImports <- struct{}{}:
		defer func() { <-jsonImports }()
	case <-ctx.Done():
		return nil, internal(ctx.Err())
	}
	timeout := cmp.Or(s.jsonReadTimeout, time.Minute)
	if err := in.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, internal(err)
	}
	in.Open(maxJSONUpload)
	body, err := io.ReadAll(&in.Stream)
	if err != nil {
		return nil, in.Failed()
	}
	// Keep a failed body's deadline in place for net/http's cleanup reads.
	// Successful uploads may spend longer importing after the body is read.
	if err := in.SetReadDeadline(time.Time{}); err != nil {
		return nil, internal(err)
	}
	res, err := s.importJSON(ctx, in.Source, body)
	if err != nil {
		return nil, importFailure(err)
	}
	return res, nil
}

func (s *Server) importUpload(ctx context.Context, in *importInput) (any, error) {
	parts, err := in.Multipart(maxUpload)
	if err != nil {
		return nil, err
	}
	var observation *eml.MailImportContext
	path, cleanup, err := saveUpload(parts, s.dataDir, &observation)
	if err != nil {
		return nil, cmp.Or(in.Failed(), importFailure(err))
	}
	defer cleanup()
	if observation != nil && in.Kind != "eml" && in.Kind != "mbox" {
		return nil, httpapi.Invalid.New("mail context requires an EML or MBOX import")
	}
	res, err := importer.Run(ctx, importer.Target{Store: s.db, Blobs: s.blobs, ArchiveDir: s.archiveDir}, in.Kind,
		importer.Input{Path: path, Source: in.Source, Account: in.Account, DateOrder: in.DateOrder, Mail: observation})
	if err != nil {
		return nil, importFailure(err)
	}
	return res, nil
}

// importFailure classifies an importer's error by the importers' own
// contract, which the inbox sweep relies on as well: a failing database, disk
// or context is marked with fail.Op, and anything else is the input's. A
// failure of the server is answered without its cause.
func importFailure(err error) error {
	if fail.IsOp(err) {
		return internal(err)
	}
	return httpapi.Invalid.New(err.Error())
}

type uploadLibraryFilesInput struct {
	Source  string `query:"source" maxLength:"4096" doc:"The source the files are filed under. Default: files."`
	Account string `query:"account" maxLength:"4096" doc:"The account at the source. Default: owner."`
	ItemID  string `query:"item_id" doc:"Link every file to this library item, which must exist."`
	httpapi.Stream
}

// uploadLibraryFiles checks everything the request names before it stores a
// byte, so a refused upload leaves no blob that nothing refers to.
func (s *Server) uploadLibraryFiles(ctx context.Context, in *uploadLibraryFilesInput) (*httpapi.Body[[]library.File], error) {
	received := time.Now()
	source, account := cmp.Or(in.Source, "files"), cmp.Or(in.Account, "owner")
	if err := archive.ValidSource(source); err != nil {
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
	s.extractAfterImport(received)
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

// Schemas are named after their Go type, and the combined search answers
// with a Result too.
type publicationResult mediaimport.Result

func (s *Server) publishLibraryPages(ctx context.Context, in *struct {
	Body strictJSON[mediaimport.Publication]
}) (*httpapi.Body[publicationResult], error) {
	result, err := mediaimport.Publish(ctx, s.db, s.archiveDir, in.Body.Value)
	if err != nil {
		return nil, importFailure(err)
	}
	return &httpapi.Body[publicationResult]{Body: publicationResult(result)}, nil
}
