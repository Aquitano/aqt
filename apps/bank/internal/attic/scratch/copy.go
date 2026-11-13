package scratch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/content"
)

var (
	ErrTooBig  = errors.New("file exceeds the copy limit")
	ErrChanged = errors.New("file changed since hashing; scan it again")
)

// CheckVolume prevents subprocess scratch files from landing on the source disk.
// On Windows both paths must resolve, so an invalid base cannot bypass the check.
func CheckVolume(source disk.Fingerprint, base string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	if base == "" {
		base = os.TempDir()
	}
	v, _, err := disk.Locate(base)
	if err != nil {
		return fmt.Errorf("temporary directory: %w", err)
	}
	if v.FS == source.FS && v.Serial == source.Serial {
		return fmt.Errorf("temporary directory %s is on the source disk; choose a temp directory on another disk", base)
	}
	return nil
}

// Copy reads through disk.Open and checks the bytes against the catalogue hash.
// External programs receive this copy, never the original's path or handle.
func (w *Workspace) Copy(ctx context.Context, source string, digest content.Digest, maxBytes int64) (path string, err error) {
	f, err := disk.Open(source)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return w.CopyOpen(ctx, f, digest, maxBytes)
}

// CopyOpen verifies an already-open source. The caller retains its handle.
func (w *Workspace) CopyOpen(ctx context.Context, f *os.File, digest content.Digest, maxBytes int64) (path string, err error) {
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return "", ErrTooBig
	}
	out, err := os.CreateTemp(w.Path, "file-*"+filepath.Ext(f.Name()))
	if err != nil {
		return "", WriteError{err}
	}
	path = out.Name()
	defer func() {
		if closeErr := out.Close(); closeErr != nil {
			err = errors.Join(err, WriteError{closeErr})
		}
		if err != nil {
			_ = os.Remove(path)
			path = ""
		}
	}()
	var reader io.Reader = f
	if maxBytes > 0 && maxBytes < math.MaxInt64 {
		reader = io.LimitReader(reader, maxBytes+1)
	}
	got, n, err := content.Hash(ctx, io.TeeReader(reader, copyWriter{out}))
	if err != nil {
		return path, err
	}
	if maxBytes > 0 && n > maxBytes {
		return path, ErrTooBig
	}
	if got != digest {
		return path, ErrChanged
	}
	return path, nil
}

// WriteError identifies a failure on the scratch disk, not on the source.
type WriteError struct{ Err error }

func (e WriteError) Error() string { return "scratch: " + e.Err.Error() }
func (e WriteError) Unwrap() error { return e.Err }

type copyWriter struct{ *os.File }

func (w copyWriter) Write(p []byte) (int, error) {
	n, err := w.File.Write(p)
	if err != nil {
		err = WriteError{err}
	}
	return n, err
}
