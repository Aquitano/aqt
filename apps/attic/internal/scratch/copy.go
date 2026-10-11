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

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"lukechampine.com/blake3"
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
func (w *Workspace) Copy(ctx context.Context, source string, digest disk.Digest, maxBytes int64) (path string, err error) {
	f, err := disk.Open(source)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if maxBytes > 0 && info.Size() > maxBytes {
		return "", ErrTooBig
	}
	out, err := os.CreateTemp(w.Path, "file-*"+filepath.Ext(source))
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
	h := blake3.New(32, nil)
	var reader io.Reader = cancelReader{ctx, f}
	if maxBytes > 0 && maxBytes < math.MaxInt64 {
		reader = io.LimitReader(reader, maxBytes+1)
	}
	n, err := io.Copy(io.MultiWriter(copyWriter{out}, h), reader)
	if err != nil {
		return path, err
	}
	if maxBytes > 0 && n > maxBytes {
		return path, ErrTooBig
	}
	var got disk.Digest
	h.Sum(got[:0])
	if got != digest {
		return path, ErrChanged
	}
	return path, nil
}

type cancelReader struct {
	ctx context.Context
	r   io.Reader
}

func (r cancelReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
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
