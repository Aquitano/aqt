// Package disk is everything attic asks of the operating system: which volume
// a path lives on, a folder's entries in bulk, and a file's BLAKE3 digest. It
// writes to the disks it reads only through Move and Folders, which dedupe
// and organize use to set copies aside and to rename reviewed files and
// folders, and Held.Restore, which puts back times another program's read
// moved.
package disk

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

// Fingerprint is what identifies a volume across reconnects, drive letters and
// machines. A sector clone shares every field except DeviceSerial.
type Fingerprint struct {
	FS string `json:"fs"`
	// Serial is upper-case hex: the full 64-bit serial on NTFS, 32 bits on FAT
	// and exFAT. GetVolumeInformation reports only the low half on NTFS.
	Serial       string `json:"serial"`
	PartitionID  string `json:"partition_id,omitempty"`
	DeviceSerial string `json:"device_serial,omitempty"`
	Size         int64  `json:"size"`
	Label        string `json:"label"`
	// StableIDs reports whether file ids survive renames and moves within the
	// volume. FAT and exFAT ids are derived from directory-entry positions.
	StableIDs bool `json:"stable_ids"`
}

// Volume is a mounted volume: its fingerprint and where the OS mounts it now.
type Volume struct {
	Fingerprint
	Root string `json:"root"`
}

// Entry is one directory entry as listed. Times are UTC; a zero time means the
// file system did not report it.
type Entry struct {
	Name string
	Dir  bool
	// Link is a reparse point: a junction, symlink or cloud placeholder.
	// attic records it and never follows or reads it.
	Link bool
	// Remote is a placeholder whose bytes live elsewhere (OneDrive, offline
	// storage). Reading it would download it, so it is never hashed.
	Remote     bool
	Size       int64
	Created    time.Time
	Modified   time.Time
	Accessed   time.Time
	Changed    time.Time
	Attributes uint32
	// FileID is the file system's id for the entry, zero when it has none.
	FileID uint64
}

// ErrInUse means another program has the file open for writing.
var ErrInUse = errors.New("in use by another program")

// ErrLocked means another process holds the lock that Lock asked for.
var ErrLocked = errors.New("locked by another process")

// Hash reads the whole file once and returns its BLAKE3-256 digest and the
// number of bytes read. Cancelling ctx stops it within one buffer, so a
// 50 GB disk image does not hold up Ctrl+C.
func Hash(ctx context.Context, path string) (content.Digest, int64, error) {
	f, err := Open(path)
	if err != nil {
		return content.Digest{}, 0, err
	}
	defer f.Close()
	return content.Hash(ctx, f)
}

// Verify rereads a held file and reports whether its bytes have digest. It
// reads by offset, so the file's own read position stays at the start.
func (f *Held) Verify(ctx context.Context, digest content.Digest) (bool, error) {
	got, _, err := content.Hash(ctx, io.NewSectionReader(f.File, 0, f.Entry.Size))
	return got == digest, err
}

// Hash reads the held object, whose Entry supplies the digest's metadata baseline.
func (f *Held) Hash(ctx context.Context) (content.Digest, int64, error) {
	return content.Hash(ctx, f.File)
}

// ReadSmall reads a small file, such as a repository's .git/config, with the
// same last-access guarantee as Hash.
func ReadSmall(path string, limit int64) ([]byte, error) {
	f, err := Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, limit))
}
