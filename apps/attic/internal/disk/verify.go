package disk

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

var ErrNotOrdinary = errors.New("not an ordinary local file or directory")

// OpenOrdinary refuses links and placeholders in every component below root.
func OpenOrdinary(root, rel string) (*os.File, error) {
	if !filepath.IsLocal(rel) {
		return nil, ErrNotOrdinary
	}
	return openOrdinary(root, filepath.Clean(rel))
}

func HashOrdinary(ctx context.Context, root, rel string) (Digest, int64, error) {
	if err := ctx.Err(); err != nil {
		return Digest{}, 0, err
	}
	f, err := OpenOrdinary(root, rel)
	if err != nil {
		return Digest{}, 0, err
	}
	defer f.Close()
	return hashReader(ctx, f)
}

// HashOrdinaryInfo is HashOrdinary that also returns the file as it was opened
// before hashing, so a caller can recognize the same file, unwritten since,
// at another path.
func HashOrdinaryInfo(ctx context.Context, root, rel string) (Digest, fs.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return Digest{}, nil, err
	}
	f, err := OpenOrdinary(root, rel)
	if err != nil {
		return Digest{}, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Digest{}, nil, err
	}
	d, _, err := hashReader(ctx, f)
	return d, info, err
}
