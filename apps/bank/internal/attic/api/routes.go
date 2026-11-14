package api

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

type body[T any] = httpapi.Body[T]

func reply[T any](v T, err error) (*body[T], error) {
	if err != nil {
		return nil, failure(err)
	}
	return &body[T]{Body: v}, nil
}

type operation = httpapi.Operation

func (s *server) register(api huma.API) {
	op := func(o operation) huma.Operation {
		o.Tag = Tag
		return o.For(api)
	}

	huma.Register(api, op(operation{ID: "searchDisks", Method: http.MethodGet, Path: "/v1/disk/search",
		Summary: "Find files on disks by name, path, text, tags or OCR, with filters by volume, folder and type",
		Description: "The combined search also finds files on disks; this one adds filters it does not have: volume, " +
			"under, ext, kind and current, and it lists what the filters select when q is empty. Each index ranks " +
			"on its own scale, so entries, archive members, document text, embedded tags and OCR or image " +
			"descriptions come back as separate lists, each up to limit long. Results include places that held a " +
			"content before the file changed; current=true leaves those out.",
		Errors: []httpapi.Kind{errNotFound}}), s.search)

	huma.Register(api, op(operation{ID: "getDiskStats", Method: http.MethodGet, Path: "/v1/disk/stats",
		Summary: "Count volumes, files, contents, documents and enrichment results"}), s.stats)

	huma.Register(api, op(operation{ID: "listDiskDupes", Method: http.MethodGet, Path: "/v1/disk/dupes",
		Summary:     "List contents stored more than once, largest waste first",
		Description: "Copies on two backup disks are usually intended; same_volume=true counts only copies that share a volume."}), s.dupes)

	huma.Register(api, op(operation{ID: "getDiskCoverage", Method: http.MethodGet, Path: "/v1/disk/coverage",
		Summary: "Report content recorded on fewer than two volumes",
		Description: "What would be lost with one disk: contents with a single recorded volume, and unhashed files " +
			"whose content is unknown. Filter by volume, and by a volume-relative folder with under.",
		Errors: []httpapi.Kind{errNotFound}}), s.coverage)

	huma.Register(api, op(operation{ID: "getDiskContent", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}",
		Summary:     "Show one content and every place on disks it lives or lived",
		Description: "Occurrences list current places first, then places that held this content before their bytes changed.",
		Errors:      []httpapi.Kind{errNotFound, AmbiguousRef}}), s.content)

	huma.Register(api, op(operation{ID: "getDiskContentText", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/text",
		Summary:     "Read a document's extracted text",
		Description: "Text is extracted once per content, by a scan or by bank, up to the first 4 MB; status says whether it was cut.",
		Errors:      []httpapi.Kind{errNotFound, AmbiguousRef}}), s.text)

	huma.Register(api, op(operation{ID: "getDiskContentMetadata", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/metadata",
		Summary: "Read embedded image, document, audio and video tags",
		Errors:  []httpapi.Kind{errNotFound, AmbiguousRef}}), s.metadata)

	huma.Register(api, op(operation{ID: "listDiskContentAnalyses", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/analyses",
		Summary: "List OCR and image descriptions, one per task, provider, model and prompt version",
		Errors:  []httpapi.Kind{errNotFound, AmbiguousRef}}), s.analyses)

	huma.Register(api, op(operation{ID: "getDiskEntry", Method: http.MethodGet, Path: "/v1/disk/entries/{id}",
		Summary:     "Show one entry: its file, folder or link, its versions and its other copies",
		Description: "Versions list every content the entry held, newest first, with the scans that saw each one arrive and change.",
		Errors:      []httpapi.Kind{errNotFound}}), s.entry)

	huma.Register(api, op(operation{ID: "listDiskVolumes", Method: http.MethodGet, Path: "/v1/disk/volumes",
		Summary: "List known volumes, their totals and last scans"}), s.volumes)

	huma.Register(api, op(operation{ID: "listDiskScans", Method: http.MethodGet, Path: "/v1/disk/scans",
		Summary: "List scans, newest first, with their phase times and counts",
		Errors:  []httpapi.Kind{errNotFound}}), s.scans)

	huma.Register(api, op(operation{ID: "getDiskScan", Method: http.MethodGet, Path: "/v1/disk/scans/{id}",
		Summary: "Show one scan",
		Errors:  []httpapi.Kind{errNotFound}}), s.scan)

	huma.Register(api, op(operation{ID: "listDiskScanSkipGroups", Method: http.MethodGet, Path: "/v1/disk/scans/{id}/skip-groups",
		Summary: "Count what a scan left out, by reason and rule",
		Errors:  []httpapi.Kind{errNotFound}}), s.skipGroups)

	huma.Register(api, op(operation{ID: "listDiskScanSkips", Method: http.MethodGet, Path: "/v1/disk/scans/{id}/skips",
		Summary: "List the paths a scan left out, by reason or rule",
		Errors:  []httpapi.Kind{errNotFound}}), s.skips)
}

type searchInput struct {
	Q       string `query:"q" doc:"Words to find. Empty lists whatever the filters select, in path order."`
	Match   string `query:"match" enum:"any,all" doc:"Every word (all, the default) or any word."`
	Volume  string `query:"volume" doc:"Volume label or ID."`
	Ext     string `query:"ext" doc:"File extension without the dot, such as pdf."`
	Kind    string `query:"kind" enum:"file,dir,link" doc:"Entry kind."`
	Under   string `query:"under" doc:"Volume-relative folder, such as /Projects/2017. Needs volume."`
	Current bool   `query:"current" doc:"Leave out places that held a content before their file changed."`
	httpapi.Page
}

func (s *server) search(ctx context.Context, in *searchInput) (*body[view.SearchResult], error) {
	o := store.SearchOptions{Query: in.Q, Any: in.Match == "any", Ext: in.Ext, Kind: in.Kind, Current: in.Current, Limit: in.Limit, Offset: in.Offset}
	var err error
	if o.VolumeID, o.Under, err = s.folder(ctx, in.Volume, in.Under); err != nil {
		return nil, err
	}
	return reply(view.Search(ctx, s.store, o, nil))
}

// folder resolves the volume and volume-relative folder filters. A mounted
// path would name a folder on the client, not on this machine.
func (s *server) folder(ctx context.Context, volume, under string) (volumeID, folder string, err error) {
	if volume != "" {
		v, err := s.store.FindVolume(ctx, volume)
		if err != nil {
			return "", "", failure(err)
		}
		volumeID = v.ID
	}
	if under == "" {
		return volumeID, "", nil
	}
	if volumeID == "" || !strings.HasPrefix(under, "/") {
		return "", "", httpapi.Invalid.New("under is a volume-relative folder starting with / and needs volume")
	}
	return volumeID, strings.TrimSuffix(under, "/"), nil
}

func (s *server) stats(ctx context.Context, _ *struct{}) (*body[view.Stats], error) {
	t, err := s.store.Totals(ctx)
	if err != nil {
		return nil, failure(err)
	}
	analyses, err := s.store.AITotals(ctx)
	return reply(view.Stats{Totals: t, Analyses: analyses}, err)
}

type dupesInput struct {
	MinSize    int64 `query:"min_size" default:"1048576" minimum:"0" doc:"Ignore contents smaller than this many bytes."`
	SameVolume bool  `query:"same_volume" doc:"Count only copies that share a volume."`
	httpapi.PageSize
}

func (s *server) dupes(ctx context.Context, in *dupesInput) (*body[view.DupeReport], error) {
	dupes, wasted, err := s.store.Dupes(ctx, in.MinSize, in.SameVolume, in.Limit)
	return reply(view.NewDupeReport(dupes, wasted, nil), err)
}

type coverageInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	Under  string `query:"under" doc:"Volume-relative folder, such as /Photos. Needs volume."`
	httpapi.Page
}

func (s *server) coverage(ctx context.Context, in *coverageInput) (*body[store.CoverageReport], error) {
	o := store.CoverageOptions{Limit: in.Limit, Offset: in.Offset}
	var err error
	if o.VolumeID, o.Under, err = s.folder(ctx, in.Volume, in.Under); err != nil {
		return nil, err
	}
	return reply(s.store.Coverage(ctx, o))
}

type refInput struct {
	Ref ref.Content `path:"ref" doc:"Content ref: content: and 16 to 64 lowercase hex characters of the BLAKE3 digest."`
}

func (s *server) content(ctx context.Context, in *refInput) (*body[view.Content], error) {
	c, err := s.store.Content(ctx, in.Ref)
	return reply(view.NewContent(c, nil), err)
}

func (s *server) text(ctx context.Context, in *refInput) (*body[store.TextDetail], error) {
	return reply(s.store.Text(ctx, 0, in.Ref))
}

func (s *server) metadata(ctx context.Context, in *refInput) (*body[store.MetadataDetail], error) {
	return reply(s.store.Metadata(ctx, 0, in.Ref))
}

func (s *server) analyses(ctx context.Context, in *refInput) (*body[[]store.Analysis], error) {
	return reply(s.store.Analyses(ctx, 0, in.Ref))
}

type idInput struct {
	ID int64 `path:"id" minimum:"1"`
}

// Schemas are named after their Go type, and the library has an Entry too.
type diskEntry view.Entry

func (s *server) entry(ctx context.Context, in *idInput) (*body[diskEntry], error) {
	d, err := s.store.Entry(ctx, in.ID)
	return reply(diskEntry(view.NewEntry(d, nil)), err)
}

func (s *server) volumes(ctx context.Context, _ *struct{}) (*body[[]store.VolumeSummary], error) {
	return reply(s.store.Volumes(ctx))
}

type scansInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	httpapi.PageSize
}

func (s *server) scans(ctx context.Context, in *scansInput) (*body[[]store.ScanInfo], error) {
	volumeID, _, err := s.folder(ctx, in.Volume, "")
	if err != nil {
		return nil, err
	}
	return reply(s.store.Scans(ctx, volumeID, in.Limit))
}

func (s *server) scan(ctx context.Context, in *idInput) (*body[store.ScanInfo], error) {
	return reply(s.store.ScanByID(ctx, in.ID))
}

func (s *server) skipGroups(ctx context.Context, in *idInput) (*body[view.SkipReport], error) {
	sc, err := s.store.ScanByID(ctx, in.ID)
	if err != nil {
		return nil, failure(err)
	}
	groups, err := s.store.SkipGroups(ctx, sc.ID)
	return reply(view.SkipReport{Scan: sc, Groups: groups}, err)
}

type skipsInput struct {
	ID     int64  `path:"id" minimum:"1"`
	Reason string `query:"reason" doc:"A reason from listDiskScanSkipGroups, such as excluded, too_big or unreadable."`
	Rule   string `query:"rule" doc:"A rule from listDiskScanSkipGroups."`
	httpapi.PageSize
}

func (s *server) skips(ctx context.Context, in *skipsInput) (*body[[]store.Skip], error) {
	if _, err := s.store.ScanByID(ctx, in.ID); err != nil {
		return nil, failure(err)
	}
	return reply(s.store.Skips(ctx, in.ID, in.Reason, in.Rule, in.Limit))
}
