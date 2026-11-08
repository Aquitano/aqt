package disk

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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

// Folders checks that each folder of rel below root is an ordinary folder,
// not a link or junction that would send a move elsewhere. Without create it
// stops at the first missing folder; with create it makes the missing ones
// and returns them relative to root.
func Folders(root, rel string, create bool) ([]string, error) {
	if rel == "." {
		return nil, nil
	}
	var created []string
	sub := ""
	for part := range strings.SplitSeq(rel, string(filepath.Separator)) {
		sub = filepath.Join(sub, part)
		dir := filepath.Join(root, sub)
		if create {
			err := os.Mkdir(dir, 0o700)
			if err == nil {
				created = append(created, sub)
			} else if !errors.Is(err, fs.ErrExist) {
				return created, err
			}
		}
		info, err := os.Lstat(dir)
		if !create && errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return created, err
		}
		if info.Mode().Type() != fs.ModeDir {
			return created, fmt.Errorf("%s is not an ordinary folder", dir)
		}
	}
	return created, nil
}
