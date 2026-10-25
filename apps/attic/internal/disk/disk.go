// Package disk is everything attic asks of the operating system: which volume
// a path lives on, a folder's entries in bulk, and a file's BLAKE3 digest. It
// writes to the disks it reads only through Move, which dedupe uses to set
// copies aside.
package disk

import (
	"context"
	"io"
	"sync"
	"time"

	"lukechampine.com/blake3"
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

type Digest [32]byte

var hashBuffers = sync.Pool{New: func() any { return new([1 << 20]byte) }}

// Hash reads the whole file once and returns its BLAKE3-256 digest and the
// number of bytes read. Cancelling ctx stops it within one buffer, so a
// 50 GB disk image does not hold up Ctrl+C.
func Hash(ctx context.Context, path string) (Digest, int64, error) {
	var d Digest
	f, err := Open(path)
	if err != nil {
		return d, 0, err
	}
	defer f.Close()
	return hashReader(ctx, f)
}

func hashReader(ctx context.Context, r io.Reader) (Digest, int64, error) {
	var d Digest
	buffer := hashBuffers.Get().(*[1 << 20]byte)
	defer hashBuffers.Put(buffer)
	h := blake3.New(len(d), nil)
	n, err := io.CopyBuffer(h, ctxReader{ctx, r}, buffer[:])
	if err != nil {
		return d, n, err
	}
	h.Sum(d[:0])
	return d, n, nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
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
