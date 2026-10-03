// Package blob is a content-addressed file store: bytes go in, a sha256 comes
// back, and identical content is stored exactly once.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
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

// Put streams r into the store and returns its sha256 hex digest and size.
// Content already present is left alone: identical bytes are stored once.
func (s *Store) Put(r io.Reader) (string, int64, error) {
	return s.put(r, false)
}

// Replace is Put for repairs: it rewrites the file even when something already
// sits at that digest's path. Only `bank verify --heal` needs it, because
// corrupted bytes are exactly the case Put's "already there" shortcut skips.
func (s *Store) Replace(r io.Reader) (string, int64, error) {
	return s.put(r, true)
}

func (s *Store) put(r io.Reader, overwrite bool) (string, int64, error) {
	tmp, err := os.CreateTemp(s.root, "put-*")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(tmp.Name())

	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), r)
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
		return "", 0, err
	}

	sum := hex.EncodeToString(h.Sum(nil))
	dest := s.Path(sum)
	if _, err := os.Stat(dest); err == nil && !overwrite {
		return sum, size, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		if !overwrite {
			if info, statErr := os.Stat(dest); statErr == nil && info.Mode().IsRegular() && info.Size() == size {
				return sum, size, nil
			}
		}
		return "", 0, err
	}
	return sum, size, nil
}

// ValidDigest rejects anything that is not a lowercase sha256 digest, so a
// digest taken from argv or off the wire can be refused where it enters rather
// than deep inside a file operation.
func ValidDigest(sum string) error {
	if len(sum) != 64 || strings.TrimLeft(sum, "0123456789abcdef") != "" {
		return fmt.Errorf("not a sha256 digest: %q", sum)
	}
	return nil
}

// Path returns where a digest's content lives (two-char fan-out dirs).
//
// Anything that is not a digest is escaped into a single unreachable name
// instead of being joined: sum reaches filepath.Join, so "../../etc/passwd"
// would otherwise resolve outside the store and be handed to whatever the
// caller does next. Callers still owe their input a ValidDigest, which is what
// turns "no such file" into an error naming what was wrong with it.
func (s *Store) Path(sum string) string {
	if ValidDigest(sum) != nil {
		return filepath.Join(s.root, "invalid-"+url.PathEscape(sum))
	}
	return filepath.Join(s.root, sum[:2], sum)
}
