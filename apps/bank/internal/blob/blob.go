// Package blob is a content-addressed file store: bytes go in, their BLAKE3
// digest comes back, and identical content is stored exactly once.
package blob

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

type Store struct {
	root string
}

func New(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

// Put streams r into the store and returns its digest and size. Content
// already present is left alone: identical bytes are stored once.
func (s *Store) Put(ctx context.Context, r io.Reader) (content.Digest, int64, error) {
	return s.put(ctx, r, false)
}

// Replace is Put for repairs: it rewrites the file even when something already
// sits at that digest's path. Only `bank verify --heal` needs it, because
// corrupted bytes are exactly the case Put's "already there" shortcut skips.
func (s *Store) Replace(ctx context.Context, r io.Reader) (content.Digest, int64, error) {
	return s.put(ctx, r, true)
}

func (s *Store) put(ctx context.Context, r io.Reader, overwrite bool) (content.Digest, int64, error) {
	tmp, err := os.CreateTemp(s.root, "put-*")
	if err != nil {
		return content.Digest{}, 0, err
	}
	defer os.Remove(tmp.Name())

	digest, size, err := content.Hash(ctx, io.TeeReader(r, tmp))
	// fsync before the rename: presence at the digest's path is treated as
	// proof of completeness, so a host crash must not be able to leave a
	// permanently trusted empty file there.
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return content.Digest{}, 0, err
	}

	dest := s.Path(digest)
	if _, err := os.Stat(dest); err == nil && !overwrite {
		return digest, size, nil
	}
	if err := makeFanOut(filepath.Dir(dest)); err != nil {
		return content.Digest{}, 0, err
	}
	// The caller commits a row naming this digest once Put returns, so the
	// rename has to be durable by then too.
	if err := publish(tmp.Name(), dest); err != nil {
		if !overwrite {
			if info, statErr := os.Stat(dest); statErr == nil && info.Mode().IsRegular() && info.Size() == size {
				return digest, size, nil
			}
		}
		return content.Digest{}, 0, err
	}
	return digest, size, nil
}

// Path returns where a digest's content lives, under a directory named for
// its first two hex characters.
func (s *Store) Path(d content.Digest) string {
	sum := d.String()
	return filepath.Join(s.root, sum[:2], sum)
}
