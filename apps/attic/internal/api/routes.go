package api

import (
	"context"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/retrieve"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/view"
)

type body[T any] struct {
	Body T
}

func reply[T any](v T, err error) (*body[T], error) {
	if err != nil {
		return nil, fail(err)
	}
	return &body[T]{Body: v}, nil
}

type operation struct {
	id, method, path, tag, summary, description string
	errors                                      []errorKind
}

func (s *Server) register(api huma.API) {
	registry := api.OpenAPI().Components.Schemas
	op := func(o operation) huma.Operation {
		return huma.Operation{
			OperationID: o.id, Method: o.method, Path: o.path, Tags: []string{o.tag},
			Summary: o.summary, Description: o.description, Responses: responses(registry, o.errors...),
		}
	}

	huma.Register(api, op(operation{id: "search", method: http.MethodGet, path: "/v1/search", tag: "catalogue",
		summary: "Find files by name, path, text, tags or OCR",
		description: "Each index ranks on its own scale, so entries, archive members, document text, embedded tags " +
			"and OCR or image descriptions come back as separate lists, each up to limit long. By default every " +
			"word has to match. Results include places that held a content before the file changed; current=true " +
			"leaves those out.",
		errors: []errorKind{errNotFound}}), s.search)

	huma.Register(api, op(operation{id: "getStats", method: http.MethodGet, path: "/v1/stats", tag: "catalogue",
		summary: "Count volumes, files, contents, documents and enrichment results"}), s.stats)

	huma.Register(api, op(operation{id: "listDupes", method: http.MethodGet, path: "/v1/dupes", tag: "catalogue",
		summary:     "List contents stored more than once, largest waste first",
		description: "Copies on two backup disks are usually intended; same_volume=true counts only copies that share a volume."}), s.dupes)

	huma.Register(api, op(operation{id: "getCoverage", method: http.MethodGet, path: "/v1/coverage", tag: "catalogue",
		summary: "Report content recorded on fewer than two volumes",
		description: "What would be lost with one disk: contents with a single recorded volume, and unhashed files " +
			"whose content is unknown. Filter by volume, and by a volume-relative folder with under.",
		errors: []errorKind{errNotFound}}), s.coverage)

	huma.Register(api, op(operation{id: "getContent", method: http.MethodGet, path: "/v1/contents/{ref}", tag: "contents",
		summary:     "Show one content and every place it lives or lived",
		description: "Occurrences list current places first, then places that held this content before their bytes changed.",
		errors:      []errorKind{errNotFound, errAmbiguous}}), s.content)

	huma.Register(api, op(operation{id: "getContentText", method: http.MethodGet, path: "/v1/contents/{ref}/text", tag: "contents",
		summary:     "Read a document's extracted text",
		description: "Text is extracted once per content, up to the first 1 MB; status says whether it was cut.",
		errors:      []errorKind{errNotFound, errAmbiguous}}), s.text)

	huma.Register(api, op(operation{id: "getContentMetadata", method: http.MethodGet, path: "/v1/contents/{ref}/metadata", tag: "contents",
		summary: "Read embedded image, document, audio and video tags",
		errors:  []errorKind{errNotFound, errAmbiguous}}), s.metadata)

	huma.Register(api, op(operation{id: "listContentAnalyses", method: http.MethodGet, path: "/v1/contents/{ref}/analyses", tag: "contents",
		summary: "List OCR and image descriptions, one per task, provider, model and prompt version",
		errors:  []errorKind{errNotFound, errAmbiguous}}), s.analyses)

	download := op(operation{id: "downloadContent", method: http.MethodGet, path: "/v1/contents/{ref}/file", tag: "contents",
		summary: "Download a file's bytes from an attached disk",
		description: "Streams the first present copy on an attached disk that the server's content rules allow, " +
			"and checks it against the catalogued BLAKE3 digest while streaming. A copy that changed since its scan " +
			"ends the response short of Content-Length rather than delivering wrong bytes. While no copy is attached, " +
			"the error lists the disks that hold one.",
		errors: []errorKind{errNotFound, errAmbiguous, errUnavailable}})
	download.Responses["200"] = &huma.Response{
		Description: "The file's bytes. ETag is its BLAKE3 digest.",
		Content:     map[string]*huma.MediaType{"application/octet-stream": {Schema: &huma.Schema{Type: "string", Format: "binary"}}},
	}
	huma.Register(api, download, s.download)

	huma.Register(api, op(operation{id: "getEntry", method: http.MethodGet, path: "/v1/entries/{id}", tag: "entries",
		summary:     "Show one entry: its file, folder or link, its versions and its other copies",
		description: "Versions list every content the entry held, newest first, with the scans that saw each one arrive and change.",
		errors:      []errorKind{errNotFound}}), s.entry)

	huma.Register(api, op(operation{id: "listVolumes", method: http.MethodGet, path: "/v1/volumes", tag: "volumes",
		summary:     "List known volumes, their totals, last scans and where they are attached",
		description: "mounted_at is set while a volume is attached to the machine serving the catalogue."}), s.volumes)

	huma.Register(api, op(operation{id: "listScans", method: http.MethodGet, path: "/v1/scans", tag: "scans",
		summary: "List scans, newest first, with their phase times and counts",
		errors:  []errorKind{errNotFound}}), s.scans)

	huma.Register(api, op(operation{id: "getScan", method: http.MethodGet, path: "/v1/scans/{id}", tag: "scans",
		summary: "Show one scan",
		errors:  []errorKind{errNotFound}}), s.scan)

	huma.Register(api, op(operation{id: "listScanSkipGroups", method: http.MethodGet, path: "/v1/scans/{id}/skip-groups", tag: "scans",
		summary: "Count what a scan left out, by reason and rule",
		errors:  []errorKind{errNotFound}}), s.skipGroups)

	huma.Register(api, op(operation{id: "listScanSkips", method: http.MethodGet, path: "/v1/scans/{id}/skips", tag: "scans",
		summary: "List the paths a scan left out, by reason or rule",
		errors:  []errorKind{errNotFound}}), s.skips)

	// Huma documents its own error type for operations that declare none; every operation here declares its errors.
	delete(registry.Map(), "ApiError")
}

type searchInput struct {
	Q       string `query:"q" doc:"Words to find. Empty lists whatever the filters select, in path order."`
	Any     bool   `query:"any" doc:"Match any word instead of every word."`
	Volume  string `query:"volume" doc:"Volume label or ID."`
	Ext     string `query:"ext" doc:"File extension without the dot, such as pdf."`
	Kind    string `query:"kind" enum:"file,dir,link" doc:"Entry kind."`
	Under   string `query:"under" doc:"Volume-relative folder, such as /Projects/2017. Needs volume."`
	Current bool   `query:"current" doc:"Leave out places that held a content before their file changed."`
	Limit   int    `query:"limit" default:"20" minimum:"1" maximum:"200" doc:"Maximum results per list."`
	Offset  int    `query:"offset" minimum:"0" doc:"Skip this many ranked results in each list."`
}

func (s *Server) search(ctx context.Context, in *searchInput) (*body[view.SearchResult], error) {
	o := store.SearchOptions{Query: in.Q, Any: in.Any, Ext: in.Ext, Kind: in.Kind, Current: in.Current, Limit: in.Limit, Offset: in.Offset}
	var err error
	if o.VolumeID, o.Under, err = s.folder(ctx, in.Volume, in.Under); err != nil {
		return nil, err
	}
	vols, err := s.store.KnownVolumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	return reply(view.Search(ctx, s.store, o, view.OnlineRoots(vols)))
}

// folder resolves the volume and volume-relative folder filters. A mounted
// path would name a folder on the client, not on this machine.
func (s *Server) folder(ctx context.Context, volume, under string) (volumeID, folder string, err error) {
	if volume != "" {
		v, err := s.store.FindVolume(ctx, volume)
		if err != nil {
			return "", "", fail(err)
		}
		volumeID = v.ID
	}
	if under == "" {
		return volumeID, "", nil
	}
	if volumeID == "" || !strings.HasPrefix(under, "/") {
		return "", "", errInvalid.new("under is a volume-relative folder starting with / and needs volume")
	}
	return volumeID, strings.TrimSuffix(under, "/"), nil
}

func (s *Server) stats(ctx context.Context, _ *struct{}) (*body[view.Stats], error) {
	t, err := s.store.Totals(ctx)
	if err != nil {
		return nil, fail(err)
	}
	analyses, err := s.store.AITotals(ctx)
	return reply(view.Stats{Totals: t, Analyses: analyses}, err)
}

type dupesInput struct {
	MinSize    int64 `query:"min_size" default:"1048576" minimum:"0" doc:"Ignore contents smaller than this many bytes."`
	SameVolume bool  `query:"same_volume" doc:"Count only copies that share a volume."`
	Limit      int   `query:"limit" default:"20" minimum:"1" maximum:"200" doc:"Maximum duplicate groups."`
}

func (s *Server) dupes(ctx context.Context, in *dupesInput) (*body[view.DupeReport], error) {
	dupes, wasted, err := s.store.Dupes(ctx, in.MinSize, in.SameVolume, in.Limit)
	if err != nil {
		return nil, fail(err)
	}
	vols, err := s.store.KnownVolumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	return reply(view.NewDupeReport(dupes, wasted, view.OnlineRoots(vols)), nil)
}

type coverageInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	Under  string `query:"under" doc:"Volume-relative folder, such as /Photos. Needs volume."`
	Limit  int    `query:"limit" default:"20" minimum:"1" maximum:"1000" doc:"Maximum contents and unknown files per page."`
	Offset int    `query:"offset" minimum:"0" doc:"Skip this many contents and unknown files."`
}

func (s *Server) coverage(ctx context.Context, in *coverageInput) (*body[store.CoverageReport], error) {
	o := store.CoverageOptions{Limit: in.Limit, Offset: in.Offset}
	var err error
	if o.VolumeID, o.Under, err = s.folder(ctx, in.Volume, in.Under); err != nil {
		return nil, err
	}
	return reply(s.store.Coverage(ctx, o))
}

type refInput struct {
	Ref string `path:"ref" doc:"Content ref: 16 to 64 hex characters, with or without the attic: prefix."`
}

func (in refInput) parse() (string, error) {
	ref, ok := store.ParseRef(in.Ref)
	if !ok {
		return "", errInvalid.new(fmt.Sprintf("%q is not a ref; a ref is 16 to 64 hex characters, optionally after attic:", in.Ref))
	}
	return ref, nil
}

func (s *Server) content(ctx context.Context, in *refInput) (*body[view.Content], error) {
	ref, err := in.parse()
	if err != nil {
		return nil, err
	}
	c, err := s.store.Content(ctx, ref)
	if err != nil {
		return nil, fail(err)
	}
	vols, err := s.store.KnownVolumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	return reply(view.NewContent(c, view.OnlineRoots(vols)), nil)
}

func (s *Server) text(ctx context.Context, in *refInput) (*body[store.TextDetail], error) {
	ref, err := in.parse()
	if err != nil {
		return nil, err
	}
	return reply(s.store.Text(ctx, 0, ref))
}

func (s *Server) metadata(ctx context.Context, in *refInput) (*body[store.MetadataDetail], error) {
	ref, err := in.parse()
	if err != nil {
		return nil, err
	}
	return reply(s.store.Metadata(ctx, 0, ref))
}

func (s *Server) analyses(ctx context.Context, in *refInput) (*body[[]store.Analysis], error) {
	ref, err := in.parse()
	if err != nil {
		return nil, err
	}
	return reply(s.store.Analyses(ctx, 0, ref))
}

func (s *Server) download(ctx context.Context, in *refInput) (*huma.StreamResponse, error) {
	ref, err := in.parse()
	if err != nil {
		return nil, err
	}
	content, err := s.store.Retrieval(ctx, 0, ref)
	if err != nil {
		return nil, fail(err)
	}
	vols, err := s.store.KnownVolumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	src, err := retrieve.Open(ctx, content, vols, disk.Mounted(), s.config)
	if err != nil {
		return nil, fail(err)
	}
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		name := path.Base(src.Source)
		hctx.SetHeader("Content-Type", contentType(name))
		hctx.SetHeader("Content-Length", fmt.Sprint(src.Size))
		hctx.SetHeader("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		hctx.SetHeader("ETag", `"`+src.Blake3+`"`)
		hctx.SetStatus(http.StatusOK)
		if err := src.Copy(hctx.BodyWriter()); err != nil {
			slog.Warn("download cut short", "ref", src.Ref, "source", src.Source, "err", err)
			// The status and some bytes are already sent; only dropping the
			// connection tells the client the body is incomplete.
			panic(http.ErrAbortHandler)
		}
	}}, nil
}

func contentType(name string) string {
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}

type idInput struct {
	ID int64 `path:"id" minimum:"1"`
}

func (s *Server) entry(ctx context.Context, in *idInput) (*body[view.Entry], error) {
	d, err := s.store.Entry(ctx, in.ID)
	if err != nil {
		return nil, fail(err)
	}
	vols, err := s.store.KnownVolumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	return reply(view.NewEntry(d, view.OnlineRoots(vols)), nil)
}

func (s *Server) volumes(ctx context.Context, _ *struct{}) (*body[[]view.VolumeStatus], error) {
	vols, err := s.store.Volumes(ctx)
	if err != nil {
		return nil, fail(err)
	}
	return reply(view.VolumeStatuses(vols), nil)
}

type scansInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	Limit  int    `query:"limit" default:"20" minimum:"1" maximum:"200"`
}

func (s *Server) scans(ctx context.Context, in *scansInput) (*body[[]store.ScanInfo], error) {
	volumeID, _, err := s.folder(ctx, in.Volume, "")
	if err != nil {
		return nil, err
	}
	return reply(s.store.Scans(ctx, volumeID, in.Limit))
}

func (s *Server) scan(ctx context.Context, in *idInput) (*body[store.ScanInfo], error) {
	return reply(s.store.ScanByID(ctx, in.ID))
}

func (s *Server) skipGroups(ctx context.Context, in *idInput) (*body[view.SkipReport], error) {
	sc, err := s.store.ScanByID(ctx, in.ID)
	if err != nil {
		return nil, fail(err)
	}
	groups, err := s.store.SkipGroups(ctx, sc.ID)
	return reply(view.SkipReport{Scan: sc, Groups: groups}, err)
}

type skipsInput struct {
	ID     int64  `path:"id" minimum:"1"`
	Reason string `query:"reason" doc:"A reason from listScanSkipGroups, such as excluded, too_big or unreadable."`
	Rule   string `query:"rule" doc:"A rule from listScanSkipGroups."`
	Limit  int    `query:"limit" default:"100" minimum:"1" maximum:"1000"`
}

func (s *Server) skips(ctx context.Context, in *skipsInput) (*body[[]store.Skip], error) {
	if _, err := s.store.ScanByID(ctx, in.ID); err != nil {
		return nil, fail(err)
	}
	return reply(s.store.Skips(ctx, in.ID, in.Reason, in.Rule, in.Limit))
}
