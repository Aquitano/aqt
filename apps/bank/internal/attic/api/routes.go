package api

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/bank/internal/attic/ai"
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

func readOp(o operation) operation {
	o.Tag = Tag
	return o
}

func writeOp(o operation) operation {
	o.Tag, o.Writes = Tag, true
	return o
}

var (
	SearchDisks = httpapi.Op[SearchInput, view.SearchResult]{Operation: readOp(operation{ID: "searchDisks", Method: http.MethodGet, Path: "/v1/disk/search",
		Summary: "Find files on disks by name, path, text, tags or OCR, with filters by volume, folder and type",
		Description: "The combined search also finds files on disks; this one adds filters it does not have: volume, " +
			"under, ext, kind and current, and it lists what the filters select when q is empty. Each index ranks " +
			"on its own scale, so entries, archive members, document text, embedded tags and OCR or image " +
			"descriptions come back as separate lists, each up to limit long. Results include places that held a " +
			"content before the file changed; current=true leaves those out.",
		Errors: []httpapi.Kind{errNotFound}})}

	GetDiskStats = httpapi.Op[struct{}, view.Stats]{Operation: readOp(operation{ID: "getDiskStats", Method: http.MethodGet, Path: "/v1/disk/stats",
		Summary: "Count volumes, files, contents, documents and enrichment results"})}

	ListDiskDupes = httpapi.Op[DupesInput, view.DupeReport]{Operation: readOp(operation{ID: "listDiskDupes", Method: http.MethodGet, Path: "/v1/disk/dupes",
		Summary:     "List contents stored more than once, largest waste first",
		Description: "Copies on two backup disks are usually intended; same_volume=true counts only copies that share a volume."})}

	GetDiskRedundancy = httpapi.Op[RedundancyInput, store.RedundancyReport]{Operation: readOp(operation{ID: "getDiskRedundancy", Method: http.MethodGet, Path: "/v1/disk/redundancy",
		Summary: "Report content recorded on fewer than two volumes",
		Description: "What would be lost with one disk: contents with a single recorded volume, and unhashed files " +
			"whose content is unknown. Filter by volume, and by a volume-relative folder with under.",
		Errors: []httpapi.Kind{errNotFound}})}

	GetDiskContent = httpapi.Op[RefInput, view.Content]{Operation: readOp(operation{ID: "getDiskContent", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}",
		Summary:     "Show one content and every place on disks it lives or lived",
		Description: "Occurrences list current places first, then places that held this content before their bytes changed.",
		Errors:      []httpapi.Kind{errNotFound, AmbiguousRef}})}

	GetDiskContentText = httpapi.Op[RefInput, store.TextDetail]{Operation: readOp(operation{ID: "getDiskContentText", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/text",
		Summary: "Read the text extracted from a content",
		Description: "Text belongs to the content, whether a disk scan, an attachment's text job or a person wrote it, " +
			"up to the first 4 MB; status says whether it was cut.",
		Errors: []httpapi.Kind{errNotFound, AmbiguousRef}})}

	GetDiskContentMetadata = httpapi.Op[RefInput, store.MetadataDetail]{Operation: readOp(operation{ID: "getDiskContentMetadata", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/metadata",
		Summary: "Read embedded image, document, audio and video tags",
		Errors:  []httpapi.Kind{errNotFound, AmbiguousRef}})}

	ListDiskContentAnalyses = httpapi.Op[RefInput, []store.Analysis]{Operation: readOp(operation{ID: "listDiskContentAnalyses", Method: http.MethodGet, Path: "/v1/disk/contents/{ref}/analyses",
		Summary: "List OCR and image descriptions, one per task, provider, model and prompt version",
		Errors:  []httpapi.Kind{errNotFound, AmbiguousRef}})}

	GetDiskCopies = httpapi.Op[CopiesInput, store.Retrieval]{Operation: readOp(operation{ID: "getDiskCopies", Method: http.MethodGet, Path: "/v1/disk/copies",
		Summary: "List the hashed files that hold a content, to copy one from a disk",
		Description: "Name the content by ref, or by an entry that holds it; that entry is listed first. The machine " +
			"the disks attach to reads one of these places and checks it against blake3.",
		Errors: []httpapi.Kind{errNotFound, AmbiguousRef}})}

	GetDiskEntry = httpapi.Op[IDInput, DiskEntry]{Operation: readOp(operation{ID: "getDiskEntry", Method: http.MethodGet, Path: "/v1/disk/entries/{id}",
		Summary:     "Show one entry: its file, folder or link, its versions and its other copies",
		Description: "Versions list every content the entry held, newest first, with the scans that saw each one arrive and change.",
		Errors:      []httpapi.Kind{errNotFound}})}

	ListDiskVolumes = httpapi.Op[struct{}, []store.VolumeSummary]{Operation: readOp(operation{ID: "listDiskVolumes", Method: http.MethodGet, Path: "/v1/disk/volumes",
		Summary:     "List known volumes, their totals and last scans",
		Description: "Each volume carries the fingerprint its disk is recognised by, so the machine the disks attach to can tell which are mounted."})}

	ListDiskVolumeFiles = httpapi.Op[VolumeFilesInput, []store.VerifyFile]{Operation: readOp(operation{ID: "listDiskVolumeFiles", Method: http.MethodGet, Path: "/v1/disk/volumes/{id}/files",
		Summary: "List the files and links below a folder with their full digests, in path order",
		Description: "Missing and unhashed entries are included. Page by passing the last entry's path and id as " +
			"after_path and after_id; a page shorter than limit is the last.",
		Errors: []httpapi.Kind{errNotFound}})}

	ResolveDiskPath = httpapi.Op[PathInput, ResolvedPath]{Operation: readOp(operation{ID: "resolveDiskPath", Method: http.MethodGet, Path: "/v1/disk/volumes/{id}/path",
		Summary: "Spell a volume-relative folder as the catalogue records it",
		Description: "Folder names on Windows ignore case, so a typed path can differ from the recorded one. Each " +
			"name that matches one recorded folder takes its spelling; the rest of the path is kept as typed.",
		Errors: []httpapi.Kind{errNotFound}})}

	ListDiskScans = httpapi.Op[ScansInput, []store.ScanInfo]{Operation: readOp(operation{ID: "listDiskScans", Method: http.MethodGet, Path: "/v1/disk/scans",
		Summary: "List scans, newest first, with their phase times and counts",
		Errors:  []httpapi.Kind{errNotFound}})}

	GetDiskScan = httpapi.Op[IDInput, store.ScanInfo]{Operation: readOp(operation{ID: "getDiskScan", Method: http.MethodGet, Path: "/v1/disk/scans/{id}",
		Summary: "Show one scan",
		Errors:  []httpapi.Kind{errNotFound}})}

	ListDiskScanSkipGroups = httpapi.Op[IDInput, view.SkipReport]{Operation: readOp(operation{ID: "listDiskScanSkipGroups", Method: http.MethodGet, Path: "/v1/disk/scans/{id}/skip-groups",
		Summary: "Count what a scan left out, by reason and rule",
		Errors:  []httpapi.Kind{errNotFound}})}

	ListDiskScanSkips = httpapi.Op[SkipsInput, []store.Skip]{Operation: readOp(operation{ID: "listDiskScanSkips", Method: http.MethodGet, Path: "/v1/disk/scans/{id}/skips",
		Summary: "List the paths a scan left out, by reason or rule",
		Errors:  []httpapi.Kind{errNotFound}})}

	PlanDiskDedupe = httpapi.Op[DedupePlanInput, []store.DedupeGroup]{Operation: readOp(operation{ID: "planDiskDedupe", Method: http.MethodPost, Path: "/v1/disk/dedupe/plan",
		Summary: "List hashed contents with present copies both inside and outside the kept folders",
		Description: "Most bytes outside first. Copies dedupe set aside are left out until a scan of their folder " +
			"finds them again. Only reads; the machine the disks attach to moves the extra copies and records " +
			"each move with recordDiskDedupeMove."})}

	RecordDiskDedupeMove = httpapi.Op[DedupeMoveInput, struct{}]{Operation: writeOp(operation{ID: "recordDiskDedupeMove", Method: http.MethodPost, Path: "/v1/disk/entries/{id}/dedupe-move",
		Summary:     "Record that an entry's copy was moved into its disk's quarantine folder",
		Description: "The kept entry must hold the same content. Recording the same entry again replaces the record."})}

	ListDiskEnrichVolumes = httpapi.Op[EnrichSelectionInput, []string]{Operation: readOp(operation{ID: "listDiskEnrichVolumes", Method: http.MethodPost, Path: "/v1/disk/enrich/volumes",
		Summary: "List the volumes that hold files an enrichment selection would read",
		Errors:  []httpapi.Kind{errNotFound, AmbiguousRef}})}

	ListDiskEnrichCandidates = httpapi.Op[EnrichCandidatesInput, []store.ContentFile]{Operation: readOp(operation{ID: "listDiskEnrichCandidates", Method: http.MethodPost, Path: "/v1/disk/enrich/candidates",
		Summary: "List the files an enrichment selection would read, by entry ID",
		Description: "Without retry, contents with no result under the key; with retry, contents whose result " +
			"failed. Page by passing the last file's id as after.",
		Errors: []httpapi.Kind{errNotFound, AmbiguousRef}})}

	ClaimDiskEnrichment = httpapi.Op[EnrichClaimInput, EnrichClaim]{Operation: writeOp(operation{ID: "claimDiskEnrichment", Method: http.MethodPost, Path: "/v1/disk/enrich/claims",
		Summary: "Lease one content's enrichment under one policy before reading it",
		Description: enrichProtocol + " claimed is false when the work is done already, unless force, or another " +
			"worker's lease has not run out."})}

	RenewDiskEnrichment = httpapi.Op[LeaseInput, store.AIClaim]{Operation: writeOp(operation{ID: "renewDiskEnrichment", Method: http.MethodPost, Path: "/v1/disk/enrich/claims/{lease}/renew",
		Summary: "Keep a lease current while the provider reads",
		Errors:  []httpapi.Kind{errClaimLost}})}

	ReleaseDiskEnrichment = httpapi.Op[LeaseInput, struct{}]{Operation: writeOp(operation{ID: "releaseDiskEnrichment", Method: http.MethodDelete, Path: "/v1/disk/enrich/claims/{lease}",
		Summary: "Give up a lease without a result, so another worker can claim the work now"})}

	SaveDiskEnrichment = httpapi.Op[SaveEnrichmentInput, struct{}]{Operation: writeOp(operation{ID: "saveDiskEnrichment", Method: http.MethodPost, Path: "/v1/disk/enrich/claims/{lease}/result",
		Summary:     "Store what the provider made of the leased content, and end the lease",
		Description: "Only the current lease saves: a result whose lease ran out and went to another worker is refused with ClaimLost and changes nothing.",
		Errors:      []httpapi.Kind{errClaimLost}})}
)

const enrichProtocol = `bank disk enrich, on the machine the disks attach to, pages through
listDiskEnrichCandidates, leases each content with claimDiskEnrichment, renews the lease
while the provider reads a copy, and ends it with saveDiskEnrichment or
releaseDiskEnrichment. A lease that is not renewed runs out after two minutes, and the
work can be claimed again.`

func (s *server) register(api huma.API) {
	httpapi.Register(api, SearchDisks, s.search)
	httpapi.Register(api, GetDiskStats, s.stats)
	httpapi.Register(api, ListDiskDupes, s.dupes)
	httpapi.Register(api, GetDiskRedundancy, s.redundancy)
	httpapi.Register(api, GetDiskContent, s.content)
	httpapi.Register(api, GetDiskContentText, s.text)
	httpapi.Register(api, GetDiskContentMetadata, s.metadata)
	httpapi.Register(api, ListDiskContentAnalyses, s.analyses)
	httpapi.Register(api, GetDiskCopies, s.copies)
	httpapi.Register(api, GetDiskEntry, s.entry)
	httpapi.Register(api, ListDiskVolumes, s.volumes)
	httpapi.Register(api, ListDiskVolumeFiles, s.volumeFiles)
	httpapi.Register(api, ResolveDiskPath, s.resolvePath)
	httpapi.Register(api, ListDiskScans, s.scans)
	httpapi.Register(api, GetDiskScan, s.scan)
	httpapi.Register(api, ListDiskScanSkipGroups, s.skipGroups)
	httpapi.Register(api, ListDiskScanSkips, s.skips)
	httpapi.Register(api, PlanDiskDedupe, s.dedupePlan)
	httpapi.RegisterEmpty(api, RecordDiskDedupeMove, s.dedupeMove)
	httpapi.Register(api, ListDiskEnrichVolumes, s.enrichVolumes)
	httpapi.Register(api, ListDiskEnrichCandidates, s.enrichCandidates)
	httpapi.Register(api, ClaimDiskEnrichment, s.claim)
	httpapi.Register(api, RenewDiskEnrichment, s.renew)
	httpapi.RegisterEmpty(api, ReleaseDiskEnrichment, s.release)
	httpapi.RegisterEmpty(api, SaveDiskEnrichment, s.save)
}

type SearchInput struct {
	Q       string `query:"q" doc:"Words to find. Empty lists whatever the filters select, in path order."`
	Match   string `query:"match" enum:"any,all" doc:"Every word (all, the default) or any word."`
	Volume  string `query:"volume" doc:"Volume label or ID."`
	Ext     string `query:"ext" doc:"File extension without the dot, such as pdf."`
	Kind    string `query:"kind" enum:"file,dir,link" doc:"Entry kind."`
	Under   string `query:"under" doc:"Volume-relative folder, such as /Projects/2017. Needs volume."`
	Current bool   `query:"current" doc:"Leave out places that held a content before their file changed."`
	httpapi.Page
}

func (s *server) search(ctx context.Context, in *SearchInput) (*body[view.SearchResult], error) {
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

type DupesInput struct {
	MinSize    int64 `query:"min_size" default:"1048576" minimum:"0" doc:"Ignore contents smaller than this many bytes."`
	SameVolume bool  `query:"same_volume" doc:"Count only copies that share a volume."`
	httpapi.PageSize
}

func (s *server) dupes(ctx context.Context, in *DupesInput) (*body[view.DupeReport], error) {
	dupes, wasted, err := s.store.Dupes(ctx, in.MinSize, in.SameVolume, in.Limit)
	return reply(view.NewDupeReport(dupes, wasted, nil), err)
}

type RedundancyInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	Under  string `query:"under" doc:"Volume-relative folder, such as /Photos. Needs volume."`
	httpapi.Page
}

func (s *server) redundancy(ctx context.Context, in *RedundancyInput) (*body[store.RedundancyReport], error) {
	o := store.RedundancyOptions{Limit: in.Limit, Offset: in.Offset}
	var err error
	if o.VolumeID, o.Under, err = s.folder(ctx, in.Volume, in.Under); err != nil {
		return nil, err
	}
	return reply(s.store.Redundancy(ctx, o))
}

type RefInput struct {
	Ref ref.Content `path:"ref" doc:"Content ref: content: and 16 to 64 lowercase hex characters of the BLAKE3 digest."`
}

func (s *server) content(ctx context.Context, in *RefInput) (*body[view.Content], error) {
	c, err := s.store.Content(ctx, in.Ref)
	return reply(view.NewContent(c, nil), err)
}

func (s *server) text(ctx context.Context, in *RefInput) (*body[store.TextDetail], error) {
	return reply(s.store.Text(ctx, 0, in.Ref))
}

func (s *server) metadata(ctx context.Context, in *RefInput) (*body[store.MetadataDetail], error) {
	return reply(s.store.Metadata(ctx, 0, in.Ref))
}

func (s *server) analyses(ctx context.Context, in *RefInput) (*body[[]store.Analysis], error) {
	return reply(s.store.Analyses(ctx, 0, in.Ref))
}

type CopiesInput struct {
	Ref   ref.Content `query:"ref" doc:"Content ref. Give this or entry."`
	Entry int64       `query:"entry" minimum:"1" doc:"An entry holding the content. Give this or ref."`
}

func (s *server) copies(ctx context.Context, in *CopiesInput) (*body[store.Retrieval], error) {
	if in.Ref.IsZero() == (in.Entry == 0) {
		return nil, httpapi.Invalid.New("give either ref or entry")
	}
	return reply(s.store.Retrieval(ctx, in.Entry, in.Ref))
}

type IDInput struct {
	ID int64 `path:"id" minimum:"1"`
}

// DiskEntry is named for the document: the library has an Entry too.
type DiskEntry view.Entry

func (s *server) entry(ctx context.Context, in *IDInput) (*body[DiskEntry], error) {
	d, err := s.store.Entry(ctx, in.ID)
	return reply(DiskEntry(view.NewEntry(d, nil)), err)
}

func (s *server) volumes(ctx context.Context, _ *struct{}) (*body[[]store.VolumeSummary], error) {
	return reply(s.store.Volumes(ctx))
}

type VolumeFilesInput struct {
	ID        string `path:"id" format:"uuid" doc:"Volume ID."`
	Under     string `query:"under" doc:"Volume-relative folder, such as /Files, or a file. Empty selects the whole volume."`
	AfterPath string `query:"after_path" doc:"The path of the previous page's last entry."`
	AfterID   int64  `query:"after_id" minimum:"0" doc:"The ID of the previous page's last entry."`
	httpapi.PageSize
}

func (s *server) volumeFiles(ctx context.Context, in *VolumeFilesInput) (*body[[]store.VerifyFile], error) {
	if in.Under != "" && !strings.HasPrefix(in.Under, "/") {
		return nil, httpapi.Invalid.New("under is a volume-relative path starting with /")
	}
	return reply(s.store.VerifyFiles(ctx, in.ID, strings.TrimSuffix(in.Under, "/"), store.VerifyFile{Path: in.AfterPath, ID: in.AfterID}, in.Limit))
}

type PathInput struct {
	ID   string `path:"id" format:"uuid" doc:"Volume ID."`
	Path string `query:"path" required:"true" doc:"Volume-relative path starting with /."`
}

type ResolvedPath struct {
	Path string `json:"path"`
}

func (s *server) resolvePath(ctx context.Context, in *PathInput) (*body[ResolvedPath], error) {
	if !strings.HasPrefix(in.Path, "/") {
		return nil, httpapi.Invalid.New("path is a volume-relative path starting with /")
	}
	p, err := s.store.ResolveVerificationPath(ctx, in.ID, in.Path)
	return reply(ResolvedPath{Path: p}, err)
}

type ScansInput struct {
	Volume string `query:"volume" doc:"Volume label or ID."`
	httpapi.PageSize
}

func (s *server) scans(ctx context.Context, in *ScansInput) (*body[[]store.ScanInfo], error) {
	volumeID, _, err := s.folder(ctx, in.Volume, "")
	if err != nil {
		return nil, err
	}
	return reply(s.store.Scans(ctx, volumeID, in.Limit))
}

func (s *server) scan(ctx context.Context, in *IDInput) (*body[store.ScanInfo], error) {
	return reply(s.store.ScanByID(ctx, in.ID))
}

func (s *server) skipGroups(ctx context.Context, in *IDInput) (*body[view.SkipReport], error) {
	sc, err := s.store.ScanByID(ctx, in.ID)
	if err != nil {
		return nil, failure(err)
	}
	groups, err := s.store.SkipGroups(ctx, sc.ID)
	return reply(view.SkipReport{Scan: sc, Groups: groups}, err)
}

type SkipsInput struct {
	ID     int64  `path:"id" minimum:"1"`
	Reason string `query:"reason" doc:"A reason from listDiskScanSkipGroups, such as excluded, too_big or unreadable."`
	Rule   string `query:"rule" doc:"A rule from listDiskScanSkipGroups."`
	httpapi.PageSize
}

func (s *server) skips(ctx context.Context, in *SkipsInput) (*body[[]store.Skip], error) {
	if _, err := s.store.ScanByID(ctx, in.ID); err != nil {
		return nil, failure(err)
	}
	return reply(s.store.Skips(ctx, in.ID, in.Reason, in.Rule, in.Limit))
}

type DedupePlanInput struct {
	Body DedupePlanRequest
}

type DedupePlanRequest struct {
	Keep    []store.KeptFolder `json:"keep" minItems:"1" doc:"Folders whose copies stay."`
	MinSize int64              `json:"min_size" minimum:"0" doc:"Ignore contents smaller than this many bytes."`
	Limit   int                `json:"limit" minimum:"1" maximum:"1000" doc:"How many contents, at most."`
}

func (s *server) dedupePlan(ctx context.Context, in *DedupePlanInput) (*body[[]store.DedupeGroup], error) {
	for _, k := range in.Body.Keep {
		if k.Path != "" && !strings.HasPrefix(k.Path, "/") {
			return nil, httpapi.Invalid.New("a kept folder is volume-relative and starts with /")
		}
	}
	groups, err := s.store.DedupePlan(ctx, in.Body.Keep, in.Body.MinSize, in.Body.Limit)
	if groups == nil {
		groups = []store.DedupeGroup{}
	}
	return reply(groups, err)
}

type DedupeMoveInput struct {
	ID   int64 `path:"id" minimum:"1" doc:"The entry whose copy was moved."`
	Body DedupeMoveRequest
}

type DedupeMoveRequest struct {
	KeptEntryID int64  `json:"kept_entry_id" minimum:"1" doc:"The entry whose copy stays."`
	MovedTo     string `json:"moved_to" minLength:"1" doc:"Where the copy is now, as the machine the disk attaches to spells it."`
}

func (s *server) dedupeMove(ctx context.Context, in *DedupeMoveInput) error {
	err := s.store.RecordDedupeMove(ctx, store.DedupeMove{EntryID: in.ID, KeptEntryID: in.Body.KeptEntryID, MovedTo: in.Body.MovedTo})
	if err != nil {
		return failure(err)
	}
	return nil
}

type EnrichSelectionInput struct {
	Body store.AISelection
}

type EnrichCandidatesInput struct {
	Body EnrichCandidatesRequest
}

type EnrichCandidatesRequest struct {
	Selection store.AISelection `json:"selection"`
	After     int64             `json:"after" minimum:"0" doc:"The previous page's last entry ID."`
	Limit     int               `json:"limit" minimum:"1" maximum:"500"`
}

// checkSelection refuses what the queries would fail on as the server's
// error: a volume ID that is no UUID, or a task the results cannot hold.
func checkSelection(o store.AISelection) error {
	for _, id := range o.Volumes {
		if _, err := uuid.Parse(id); err != nil {
			return httpapi.Invalid.New("volume " + id + " is not a volume ID")
		}
	}
	return checkKey(o.Key)
}

func checkKey(k ai.Key) error {
	if !slices.Contains([]string{ai.OCR, ai.Describe}, k.Task) {
		return httpapi.Invalid.New("task is ocr or describe")
	}
	return nil
}

func (s *server) enrichVolumes(ctx context.Context, in *EnrichSelectionInput) (*body[[]string], error) {
	if err := checkSelection(in.Body); err != nil {
		return nil, err
	}
	vols, err := s.store.AIVolumes(ctx, in.Body)
	if vols == nil {
		vols = []string{}
	}
	return reply(vols, err)
}

func (s *server) enrichCandidates(ctx context.Context, in *EnrichCandidatesInput) (*body[[]store.ContentFile], error) {
	if err := checkSelection(in.Body.Selection); err != nil {
		return nil, err
	}
	files, err := s.store.NextAI(ctx, in.Body.Selection, in.Body.After, in.Body.Limit)
	if files == nil {
		files = []store.ContentFile{}
	}
	return reply(files, err)
}

type EnrichClaimInput struct {
	Body EnrichClaimRequest
}

type EnrichClaimRequest struct {
	ContentID int64  `json:"content_id" minimum:"1" doc:"From listDiskEnrichCandidates."`
	Key       ai.Key `json:"key"`
	Force     bool   `json:"force,omitempty" doc:"Claim the work even when a result exists."`
}

// EnrichClaim is a lease on the work, or claimed false when there is none to
// have.
type EnrichClaim struct {
	Claimed bool       `json:"claimed"`
	Lease   string     `json:"lease,omitempty" doc:"Send it to renew, release or save the work."`
	Expires *time.Time `json:"expires_at,omitempty" doc:"When another worker may claim the work, unless the lease is renewed first."`
}

func (s *server) claim(ctx context.Context, in *EnrichClaimInput) (*body[EnrichClaim], error) {
	if err := checkKey(in.Body.Key); err != nil {
		return nil, err
	}
	c, err := s.store.ClaimAI(ctx, in.Body.ContentID, in.Body.Key, in.Body.Force)
	if c == nil {
		return reply(EnrichClaim{}, err)
	}
	return reply(EnrichClaim{Claimed: true, Lease: c.Lease, Expires: &c.Expires}, err)
}

type LeaseInput struct {
	Lease string `path:"lease" format:"uuid"`
}

func (s *server) renew(ctx context.Context, in *LeaseInput) (*body[store.AIClaim], error) {
	return reply(s.store.RenewAI(ctx, in.Lease))
}

func (s *server) release(ctx context.Context, in *LeaseInput) error {
	if err := s.store.ReleaseAI(ctx, in.Lease); err != nil {
		return failure(err)
	}
	return nil
}

type SaveEnrichmentInput struct {
	Lease string `path:"lease" format:"uuid"`
	Body  store.AIOutcome
}

func (s *server) save(ctx context.Context, in *SaveEnrichmentInput) error {
	if err := s.store.SaveAI(ctx, in.Lease, in.Body); err != nil {
		return failure(err)
	}
	return nil
}
