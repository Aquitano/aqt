package api

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/aquitano/aqt/apps/bank/internal/attic/session"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
)

// MaxBatchBytes bounds a batch. A scan sends one at about 4 MiB, and one
// operation, such as a document's text, can be up to 16 MiB on its own.
const MaxBatchBytes = 64 << 20

const scanProtocol = `bank disk scan, on the machine the disks attach to, writes the catalogue through
these operations: resolveDiskVolume, startDiskScan, then batches of its work with
writeDiskScan, interleaved with the list*Work operations that say what is left to
hash, list, read or tag, and a last batch that finishes the scan. A scan that sends
nothing for idle_seconds is recorded as interrupted.`

func scanOp(o httpapi.Operation) httpapi.Operation {
	o.Tag, o.Writes = Tag, true
	return o
}

var (
	ResolveDiskVolume = httpapi.Op[VolumeInput, store.Volume]{Operation: scanOp(httpapi.Operation{ID: "resolveDiskVolume", Method: http.MethodPost, Path: "/v1/disk/volumes/resolve",
		Summary: "Find or record the volume a mounted disk is",
		Description: "Matches the fingerprint against known volumes. A fingerprint that resembles a known volume " +
			"without matching it answers AmbiguousVolume: retry with volume_id if the disk is one of the " +
			"candidates, or new_volume if it is another disk.",
		Errors: []httpapi.Kind{errNotFound, AmbiguousVolume}})}

	StartDiskScan = httpapi.Op[StartInput, session.StartedScan]{Operation: scanOp(httpapi.Operation{ID: "startDiskScan", Method: http.MethodPost, Path: "/v1/disk/scans",
		Summary:     "Start a scan of a folder of a volume",
		Description: scanProtocol,
		Errors:      []httpapi.Kind{errNotFound, errScanRunning}})}

	WriteDiskScan = httpapi.Op[BatchInput, session.BatchResult]{Operation: scanOp(httpapi.Operation{ID: "writeDiskScan", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/batches",
		Summary: "Apply a batch of a scan's work",
		Description: "Applies the operations in order and commits them before answering. Batches are numbered " +
			"from 1; sending the last batch again returns its answer without applying it twice. When a " +
			"listing needs to know whether a catalogued path still holds a file, the batch is not applied " +
			"and answers questions instead: send it again with an answer to each. A batch that fails ends " +
			"the scan as failed.",
		Errors: []httpapi.Kind{errNotFound}})}

	KeepDiskScanAlive = httpapi.Op[ScanIDInput, struct{}]{Operation: scanOp(httpapi.Operation{ID: "keepDiskScanAlive", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/keepalive",
		Summary: "Keep a scan open while it reads a large file",
		Errors:  []httpapi.Kind{errNotFound}})}

	ListDiskScanHashWork = httpapi.Op[WorkInput, session.Work[session.HashWork]]{Operation: scanOp(httpapi.Operation{ID: "listDiskScanHashWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/hashes",
		Summary: "List files below the scan root whose digest is unknown, in path order",
		Errors:  []httpapi.Kind{errNotFound}})}
	ListDiskScanArchiveWork = httpapi.Op[WorkInput, session.Work[store.PendingArchive]]{Operation: scanOp(httpapi.Operation{ID: "listDiskScanArchiveWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/archives",
		Summary: "List archives below the scan root without a listing at their folder's depth, in path order",
		Errors:  []httpapi.Kind{errNotFound}})}
	ListDiskScanTextWork = httpapi.Op[WorkInput, session.Work[store.PendingText]]{Operation: scanOp(httpapi.Operation{ID: "listDiskScanTextWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/texts",
		Summary: "List documents below the scan root whose content has no text, in path order",
		Errors:  []httpapi.Kind{errNotFound}})}
	ListDiskScanMetadataWork = httpapi.Op[WorkInput, session.Work[session.MetadataWork]]{Operation: scanOp(httpapi.Operation{ID: "listDiskScanMetadataWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/metadata",
		Summary: "List files below the scan root whose content has no embedded metadata, in path order",
		Errors:  []httpapi.Kind{errNotFound}})}

	CheckDiskScanListing = httpapi.Op[ListingInput, session.ListingNeeded]{Operation: scanOp(httpapi.Operation{ID: "checkDiskScanListing", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/listings/check",
		Summary: "Say whether a content still needs an archive listing at a depth",
		Errors:  []httpapi.Kind{errNotFound}})}

	GetDiskScanArchivePart = httpapi.Op[PartInput, store.Stamp]{Operation: scanOp(httpapi.Operation{ID: "getDiskScanArchivePart", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/archive-part",
		Summary: "Show how the catalogue saw a multipart archive's sibling volume",
		Errors:  []httpapi.Kind{errNotFound}})}
)

func (s *server) registerScans(api huma.API) {
	httpapi.Register(api, ResolveDiskVolume, s.resolveVolume)
	httpapi.Register(api, StartDiskScan, s.startScan)
	httpapi.Register(api, WriteDiskScan, s.writeScan, maxBody(MaxBatchBytes))
	httpapi.RegisterEmpty(api, KeepDiskScanAlive, s.keepAlive)
	httpapi.Register(api, ListDiskScanHashWork, s.hashWork, maxBody(8<<20))
	httpapi.Register(api, ListDiskScanArchiveWork, s.archiveWork, maxBody(8<<20))
	httpapi.Register(api, ListDiskScanTextWork, s.textWork, maxBody(8<<20))
	httpapi.Register(api, ListDiskScanMetadataWork, s.metadataWork, maxBody(8<<20))
	httpapi.Register(api, CheckDiskScanListing, s.checkListing)
	httpapi.Register(api, GetDiskScanArchivePart, s.archivePart)
}

func maxBody(n int64) func(*huma.Operation) {
	return func(op *huma.Operation) {
		op.MaxBodyBytes, op.BodyReadTimeout = n, 2*time.Minute
	}
}

type VolumeInput struct {
	Body session.VolumeRequest
}

func (s *server) resolveVolume(ctx context.Context, in *VolumeInput) (*body[store.Volume], error) {
	return reply(s.sessions.Resolve(ctx, in.Body))
}

type StartInput struct {
	Body session.ScanStart
}

func (s *server) startScan(ctx context.Context, in *StartInput) (*body[session.StartedScan], error) {
	return reply(s.sessions.Start(ctx, in.Body))
}

type BatchInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.Batch
}

func (s *server) writeScan(ctx context.Context, in *BatchInput) (*body[session.BatchResult], error) {
	return reply(s.sessions.Apply(ctx, in.ID, in.Body))
}

type ScanIDInput struct {
	ID int64 `path:"id" minimum:"1"`
}

func (s *server) keepAlive(_ context.Context, in *ScanIDInput) error {
	if err := s.sessions.Touch(in.ID); err != nil {
		return failure(err)
	}
	return nil
}

type WorkInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.WorkRequest
}

func (s *server) hashWork(ctx context.Context, in *WorkInput) (*body[session.Work[session.HashWork]], error) {
	return reply(s.sessions.Hashes(ctx, in.ID, in.Body))
}

func (s *server) archiveWork(ctx context.Context, in *WorkInput) (*body[session.Work[store.PendingArchive]], error) {
	return reply(s.sessions.Archives(ctx, in.ID, in.Body))
}

func (s *server) textWork(ctx context.Context, in *WorkInput) (*body[session.Work[store.PendingText]], error) {
	return reply(s.sessions.Texts(ctx, in.ID, in.Body))
}

func (s *server) metadataWork(ctx context.Context, in *WorkInput) (*body[session.Work[session.MetadataWork]], error) {
	return reply(s.sessions.Metadata(ctx, in.ID, in.Body))
}

type ListingInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.ListingCheck
}

func (s *server) checkListing(ctx context.Context, in *ListingInput) (*body[session.ListingNeeded], error) {
	return reply(s.sessions.NeedsListing(ctx, in.ID, in.Body))
}

type PartInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.ArchivePartRequest
}

func (s *server) archivePart(ctx context.Context, in *PartInput) (*body[store.Stamp], error) {
	return reply(s.sessions.ArchivePart(ctx, in.ID, in.Body))
}
