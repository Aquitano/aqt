package disk

import (
	"context"
	"errors"
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
