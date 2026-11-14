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

const scanProtocol = `attic scan, on the machine the disks attach to, writes the catalogue through
these operations: resolveDiskVolume, startDiskScan, then batches of its work with
writeDiskScan, interleaved with the list*Work operations that say what is left to
hash, list, read or tag, and a last batch that finishes the scan. A scan that sends
nothing for idle_seconds is recorded as interrupted.`

func (s *server) registerScans(api huma.API) {
	op := func(o operation, maxBody int64) huma.Operation {
		o.Tag, o.Writes = Tag, true
		h := o.For(api)
		if maxBody > 0 {
			h.MaxBodyBytes, h.BodyReadTimeout = maxBody, 2*time.Minute
		}
		return h
	}

	huma.Register(api, op(operation{ID: "resolveDiskVolume", Method: http.MethodPost, Path: "/v1/disk/volumes/resolve",
		Summary: "Find or record the volume a mounted disk is",
		Description: "Matches the fingerprint against known volumes. A fingerprint that resembles a known volume " +
			"without matching it answers AmbiguousVolume: retry with volume_id if the disk is one of the " +
			"candidates, or new_volume if it is another disk.",
		Errors: []httpapi.Kind{errNotFound, AmbiguousVolume}}, 0), s.resolveVolume)

	huma.Register(api, op(operation{ID: "startDiskScan", Method: http.MethodPost, Path: "/v1/disk/scans",
		Summary:     "Start a scan of a folder of a volume",
		Description: scanProtocol,
		Errors:      []httpapi.Kind{errNotFound, errScanRunning}}, 0), s.startScan)

	huma.Register(api, op(operation{ID: "writeDiskScan", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/batches",
		Summary: "Apply a batch of a scan's work",
		Description: "Applies the operations in order and commits them before answering. Batches are numbered " +
			"from 1; sending the last batch again returns its answer without applying it twice. When a " +
			"listing needs to know whether a catalogued path still holds a file, the batch is not applied " +
			"and answers questions instead: send it again with an answer to each. A batch that fails ends " +
			"the scan as failed.",
		Errors: []httpapi.Kind{errNotFound}}, MaxBatchBytes), s.writeScan)

	huma.Register(api, op(operation{ID: "keepDiskScanAlive", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/keepalive",
		Summary: "Keep a scan open while it reads a large file",
		Errors:  []httpapi.Kind{errNotFound}}, 0), s.keepAlive)

	huma.Register(api, op(operation{ID: "listDiskScanHashWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/hashes",
		Summary: "List files below the scan root whose digest is unknown, in path order",
		Errors:  []httpapi.Kind{errNotFound}}, 8<<20), s.hashWork)
	huma.Register(api, op(operation{ID: "listDiskScanArchiveWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/archives",
		Summary: "List archives below the scan root without a listing at their folder's depth, in path order",
		Errors:  []httpapi.Kind{errNotFound}}, 8<<20), s.archiveWork)
	huma.Register(api, op(operation{ID: "listDiskScanTextWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/texts",
		Summary: "List documents below the scan root whose content has no text, in path order",
		Errors:  []httpapi.Kind{errNotFound}}, 8<<20), s.textWork)
	huma.Register(api, op(operation{ID: "listDiskScanMetadataWork", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/work/metadata",
		Summary: "List files below the scan root whose content has no embedded metadata, in path order",
		Errors:  []httpapi.Kind{errNotFound}}, 8<<20), s.metadataWork)

	huma.Register(api, op(operation{ID: "checkDiskScanListing", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/listings/check",
		Summary: "Say whether a content still needs an archive listing at a depth",
		Errors:  []httpapi.Kind{errNotFound}}, 0), s.checkListing)

	huma.Register(api, op(operation{ID: "getDiskScanArchivePart", Method: http.MethodPost, Path: "/v1/disk/scans/{id}/archive-part",
		Summary: "Show how the catalogue saw a multipart archive's sibling volume",
		Errors:  []httpapi.Kind{errNotFound}}, 0), s.archivePart)
}

type volumeInput struct {
	Body session.VolumeRequest
}

func (s *server) resolveVolume(ctx context.Context, in *volumeInput) (*body[store.Volume], error) {
	return reply(s.sessions.Resolve(ctx, in.Body))
}

type startInput struct {
	Body session.ScanStart
}

func (s *server) startScan(ctx context.Context, in *startInput) (*body[session.StartedScan], error) {
	return reply(s.sessions.Start(ctx, in.Body))
}

type batchInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.Batch
}

func (s *server) writeScan(ctx context.Context, in *batchInput) (*body[session.BatchResult], error) {
	return reply(s.sessions.Apply(ctx, in.ID, in.Body))
}

func (s *server) keepAlive(_ context.Context, in *idInput) (*struct{}, error) {
	if err := s.sessions.Touch(in.ID); err != nil {
		return nil, failure(err)
	}
	return nil, nil
}

type workInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.WorkRequest
}

func (s *server) hashWork(ctx context.Context, in *workInput) (*body[session.Work[session.HashWork]], error) {
	return reply(s.sessions.Hashes(ctx, in.ID, in.Body))
}

func (s *server) archiveWork(ctx context.Context, in *workInput) (*body[session.Work[store.PendingArchive]], error) {
	return reply(s.sessions.Archives(ctx, in.ID, in.Body))
}

func (s *server) textWork(ctx context.Context, in *workInput) (*body[session.Work[store.PendingText]], error) {
	return reply(s.sessions.Texts(ctx, in.ID, in.Body))
}

func (s *server) metadataWork(ctx context.Context, in *workInput) (*body[session.Work[session.MetadataWork]], error) {
	return reply(s.sessions.Metadata(ctx, in.ID, in.Body))
}

type listingInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.ListingCheck
}

func (s *server) checkListing(ctx context.Context, in *listingInput) (*body[session.ListingNeeded], error) {
	return reply(s.sessions.NeedsListing(ctx, in.ID, in.Body))
}

type partInput struct {
	ID   int64 `path:"id" minimum:"1"`
	Body session.ArchivePartRequest
}

func (s *server) archivePart(ctx context.Context, in *partInput) (*body[store.Stamp], error) {
	return reply(s.sessions.ArchivePart(ctx, in.ID, in.Body))
}
