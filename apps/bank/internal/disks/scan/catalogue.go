package scan

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/disks/config"
	"github.com/aquitano/aqt/apps/bank/internal/disks/disk"
	"github.com/aquitano/aqt/apps/bank/internal/disks/metadata"
	"github.com/aquitano/aqt/apps/bank/internal/disks/unpack"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// Catalogue is where a scan records what it finds: bank serve's API, called
// over HTTP from the machine with the disks or in process (Remote). The tests
// also scan straight into the database (Local), to show both record the same.
type Catalogue interface {
	ResolveVolume(ctx context.Context, mounted disk.Volume, forceID string, forceNew bool) (store.Volume, error)
	StartScan(ctx context.Context, v store.Volume, root string) (Session, error)
}

// Session is one scan's share of the catalogue, with the meaning store.Scan
// gives each method. A Dir's ID is the session's own handle for the folder.
// Writes can wait until Commit, a read or Finish; what a write answers, such
// as the folders a listing records, is known before the write is sent.
type Session interface {
	ID() int64
	Counts() store.ScanCounts
	Skip(entryPath, reason, rule, detail string)
	SetStatus(ctx context.Context, status string) error
	MaybeCommit(ctx context.Context) error
	Commit(ctx context.Context) error
	// Finish ends the scan and says how many files below its root still wait
	// for a hash.
	Finish(ctx context.Context, status string, phases store.PhaseTimes, failure error) (int64, error)

	ApplyListing(ctx context.Context, parent *store.Dir, listed []store.Listed, keep map[string]bool, complete bool,
		holds func(entryPath string, fileID int64) bool) ([]store.Dir, error)
	SetGitRemote(ctx context.Context, dir store.Dir, remote string) error
	QueueHardLinkHashes(ctx context.Context) error

	PendingTotals(ctx context.Context) (files, bytes int64, err error)
	NextPending(ctx context.Context, after store.Pending, limit int) ([]store.Pending, error)
	SetContent(ctx context.Context, p store.Pending, digest [32]byte) error
	ReuseContent(ctx context.Context, p store.Pending, observed disk.Entry) (bool, error)
	HashFailed(ctx context.Context, p store.Pending, failure error) error
	SkipHash(ctx context.Context, p store.Pending, reason, rule, detail string) error
	RebuildContent(ctx context.Context) error

	ArchiveTotals(ctx context.Context, ranges []config.ArchiveRange, unpackMaxBytes int64) (int64, error)
	NextArchives(ctx context.Context, after store.PendingArchive, limit int, ranges []config.ArchiveRange, unpackMaxBytes int64) ([]store.PendingArchive, error)
	StartListing(ctx context.Context, contentID int64, depth int, unpackMaxBytes int64) (Listing, error)
	ArchivePart(ctx context.Context, path string) (store.Stamp, error)

	TextTotals(ctx context.Context, exts []string) (int64, error)
	NextTexts(ctx context.Context, after store.PendingText, exts []string, limit int) ([]store.PendingText, error)
	SetText(ctx context.Context, contentID int64, t store.DocumentText) error

	MetadataTotals(ctx context.Context) (int64, error)
	NextMetadata(ctx context.Context, after store.ContentFile, limit int) ([]store.ContentFile, error)
	SetMetadata(ctx context.Context, contentID int64, result metadata.Result) error
}

// Listing is one archive's listing; nothing of it is kept until Finish.
type Listing interface {
	Add(ctx context.Context, m unpack.Member) error
	Finish(ctx context.Context, res unpack.Result) error
	Abort(ctx context.Context)
}
