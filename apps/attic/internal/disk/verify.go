package disk

import (
	"context"
	"errors"
	"path/filepath"
)

var ErrNotOrdinary = errors.New("not an ordinary local file or directory")

// HashOrdinary refuses links and placeholders in every component below root.
func HashOrdinary(ctx context.Context, root, rel string) (Digest, int64, error) {
	if err := ctx.Err(); err != nil {
		return Digest{}, 0, err
	}
	if !filepath.IsLocal(rel) {
		return Digest{}, 0, ErrNotOrdinary
	}
	f, err := openOrdinary(root, filepath.Clean(rel))
	if err != nil {
		return Digest{}, 0, err
	}
	defer f.Close()
	return hashReader(ctx, f)
}
