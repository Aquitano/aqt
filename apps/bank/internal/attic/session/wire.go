package session

import (
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/metadata"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/content"
)

// MountedVolume is a disk as the scanning machine sees it.
type MountedVolume disk.Volume

type VolumeRequest struct {
	Mounted   MountedVolume `json:"mounted"`
	VolumeID  string        `json:"volume_id,omitempty" doc:"The known volume this disk is, after an AmbiguousVolume answer."`
	NewVolume bool          `json:"new_volume,omitempty" doc:"Record a new volume even when the fingerprint resembles a known one."`
}

type ScanStart struct {
	VolumeID string `json:"volume_id" doc:"From resolveDiskVolume."`
	Root     string `json:"root" doc:"The scanned folder, volume-relative: empty for the whole volume, /Files for E:\\Files."`
}

type StartedScan struct {
	ScanID      int64 `json:"scan_id"`
	IdleSeconds int   `json:"idle_seconds" doc:"A scan that sends nothing for this long is recorded as interrupted and its volume released."`
}

// Batch is the work a scan did since its last batch, in the order it did
// it. The server applies it and commits before it answers.
type Batch struct {
	Seq     int64          `json:"seq" minimum:"1" doc:"Numbers the scan's batches from 1. A batch whose number was applied already is answered again and not applied twice, so a batch whose answer was lost can be sent again."`
	Ops     []Op           `json:"ops"`
	Answers []HoldsAnswer  `json:"answers,omitempty" maxItems:"100000" doc:"Answers to the questions an earlier attempt at this batch returned."`
	Finish  *FinishRequest `json:"finish,omitempty" doc:"Ends the scan after the operations."`
}

// Op is one thing a scan did; exactly one field is set.
type Op struct {
	Status     string          `json:"status,omitempty" enum:"hashing,listing,reading,metadata" doc:"The phase the scan entered."`
	Skip       *ScanSkip       `json:"skip,omitempty"`
	Listing    *FolderListing  `json:"listing,omitempty"`
	HardLinks  bool            `json:"hard_links,omitempty" doc:"The walk ended: queue hard links whose digests disagree for hashing."`
	Hash       *HashResult     `json:"hash,omitempty"`
	Reuse      *LinkReuse      `json:"reuse,omitempty"`
	HashFailed *HashFailure    `json:"hash_failed,omitempty"`
	SkipHash   *HashSkip       `json:"skip_hash,omitempty"`
	Rebuild    bool            `json:"rebuild_content,omitempty" doc:"Discard archive listings and document text of the hashed files below the scan root."`
	Archive    *ArchiveChunk   `json:"archive,omitempty"`
	Text       *DocumentResult `json:"text,omitempty"`
	Metadata   *MetadataResult `json:"metadata,omitempty"`
}

type ScanSkip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Rule   string `json:"rule,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// FolderListing is one folder as the scan listed it, or a part of one. Folders
// are numbered by the scan: the entry that names a folder gives its number,
// and the listing of that folder refers to it.
type FolderListing struct {
	Folder    int64         `json:"folder" doc:"The listed folder's number; 0 lists the volume root itself."`
	Entries   []ListedEntry `json:"entries" maxItems:"100000"`
	More      bool          `json:"more,omitempty" doc:"More entries of this folder follow in a later listing; the folder is reconciled when the last part arrives."`
	Keep      [][]byte      `json:"keep,omitempty" doc:"Names of entries that exist but were excluded: neither recorded nor marked missing."`
	Complete  bool          `json:"complete,omitempty" doc:"The listing is the whole folder, so entries it lacks are missing."`
	GitRemote *string       `json:"git_remote,omitempty" doc:"The folder is a git repository with this origin, empty when it has none."`
}

type ListedEntry struct {
	Name       []byte    `json:"name" doc:"The name's bytes as the file system returned them."`
	Kind       string    `json:"kind" enum:"file,dir,link"`
	Folder     int64     `json:"folder,omitempty" doc:"A folder's number, for its own listing."`
	FileID     int64     `json:"file_id,omitempty"`
	Size       int64     `json:"size"`
	Created    time.Time `json:"created,omitzero"`
	Modified   time.Time `json:"modified,omitzero"`
	Accessed   time.Time `json:"accessed,omitzero"`
	Changed    time.Time `json:"changed,omitzero"`
	Attributes int32     `json:"attributes"`
	HashState  string    `json:"hash_state" enum:"pending,skipped"`
}

type HashResult struct {
	File   store.Pending  `json:"file"`
	Digest content.Digest `json:"digest"`
}

// LinkReuse takes the digest of a hard link already hashed, for a file the
// scan held and found unchanged.
type LinkReuse struct {
	File     store.Pending `json:"file"`
	Modified time.Time     `json:"modified"`
	Changed  time.Time     `json:"changed"`
}

type HashFailure struct {
	File  store.Pending `json:"file"`
	Error string        `json:"error"`
}

type HashSkip struct {
	File   store.Pending `json:"file"`
	Reason string        `json:"reason"`
	Rule   string        `json:"rule,omitempty"`
	Detail string        `json:"detail,omitempty"`
}

// ArchiveChunk carries members of one archive's listing. A listing can span
// batches; it is applied, in one transaction, when the chunk with its
// outcome arrives.
type ArchiveChunk struct {
	ContentID      int64           `json:"content_id"`
	Depth          int             `json:"depth"`
	UnpackMaxBytes int64           `json:"unpack_max_bytes"`
	Members        []ArchiveMember `json:"members,omitempty" maxItems:"100000"`
	Outcome        *ArchiveOutcome `json:"outcome,omitempty" doc:"Set on the last chunk."`
	Abort          bool            `json:"abort,omitempty" doc:"Drop the chunks sent so far."`
}

type ArchiveMember struct {
	Path      string    `json:"path"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind" enum:"file,dir,link"`
	Size      int64     `json:"size"`
	Modified  time.Time `json:"modified,omitzero"`
	CRC32     *uint32   `json:"crc32,omitempty"`
	Encrypted bool      `json:"encrypted,omitempty"`
}

type ArchiveOutcome struct {
	Format           string `json:"format"`
	Status           string `json:"status"`
	Detail           string `json:"detail,omitempty"`
	Incomplete       bool   `json:"incomplete,omitempty"`
	CacheableFailure bool   `json:"cacheable_failure,omitempty"`
}

type DocumentResult struct {
	ContentID int64              `json:"content_id"`
	Text      store.DocumentText `json:"text"`
}

// ExifResult is what ExifTool read from one content.
type ExifResult metadata.Result

type MetadataResult struct {
	ContentID int64      `json:"content_id"`
	Result    ExifResult `json:"result"`
}

// HoldsQuestion asks whether a catalogued path still holds a file id. Only
// the machine with the disk can tell, so a batch whose listings need an
// answer is not applied and returns its questions instead.
type HoldsQuestion = store.Location

type HoldsAnswer struct {
	store.Location
	Holds bool `json:"holds" doc:"The path holds that file id, or the scan cannot tell."`
}

type FinishRequest struct {
	Status string           `json:"status" enum:"complete,failed,interrupted"`
	Error  string           `json:"error,omitempty"`
	Phases store.PhaseTimes `json:"phases"`
}

type BatchResult struct {
	Counts    store.ScanCounts `json:"counts" doc:"The scan's counts after the batch."`
	Questions []HoldsQuestion  `json:"questions,omitempty" doc:"The batch was not applied: send it again, with the same seq, and an answer to each."`
	Finished  bool             `json:"finished,omitempty" doc:"The batch finished the scan."`
	Pending   int64            `json:"pending,omitempty" doc:"After finish: files below the scan root still waiting for a hash."`
}

// WorkRequest pages through one kind of work below the scan root, in path
// order.
type WorkRequest struct {
	AfterPath      string               `json:"after_path,omitempty" doc:"The path of the last item of the previous page."`
	AfterID        int64                `json:"after_id,omitempty" doc:"The id of the last item of the previous page."`
	Limit          int                  `json:"limit" minimum:"0" maximum:"5000"`
	Count          bool                 `json:"count,omitempty" doc:"Also count the work left."`
	Extensions     []string             `json:"extensions,omitempty" maxItems:"1000" doc:"Text work: the extensions to read."`
	Ranges         []ArchivePolicyRange `json:"ranges,omitempty" maxItems:"100000" doc:"Archive work: the requested depth by path range."`
	UnpackMaxBytes int64                `json:"unpack_max_bytes,omitempty"`
}

type ArchivePolicyRange struct {
	Lower string `json:"lower"`
	Upper string `json:"upper"`
	Depth int    `json:"depth"`
}

type Work[T any] struct {
	Total int64 `json:"total,omitempty" doc:"With count: the work left, one per content except for hashes."`
	Bytes int64 `json:"bytes,omitempty" doc:"With count, for hashes: their bytes."`
	Items []T   `json:"items"`
}

// HashWork is a file waiting for its digest.
type HashWork struct {
	store.Pending
	Reusable bool `json:"reusable,omitempty" doc:"A trusted hard link already holds the digest under the same stamp."`
}

type MetadataWork struct {
	ID        int64       `json:"id"`
	Path      string      `json:"path"`
	ContentID int64       `json:"content_id"`
	Size      int64       `json:"size"`
	Stamp     store.Stamp `json:"stamp"`
}

type ListingCheck struct {
	ContentID      int64 `json:"content_id"`
	Depth          int   `json:"depth"`
	UnpackMaxBytes int64 `json:"unpack_max_bytes"`
}

type ListingNeeded struct {
	Needed bool `json:"needed" doc:"No listing at this depth is cached or remembered as failed."`
}

type ArchivePartRequest struct {
	Path string `json:"path" doc:"Volume-relative path of a multipart archive's sibling volume."`
}
