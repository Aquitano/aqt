// Package blob is a content-addressed file store: bytes go in, a sha256 comes
// back, and identical content is stored exactly once.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
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
func (s *Store) Put(r io.Reader) (string, int64, error) {
	tmp, err := os.CreateTemp(s.root, "put-*")
	if err != nil {
		return "", 0, err
	}
	defer os.Remove(tmp.Name())

	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), r)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", 0, err
	}

	sum := hex.EncodeToString(h.Sum(nil))
	dest := s.Path(sum)
	if _, err := os.Stat(dest); err == nil {
		return sum, size, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return "", 0, err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return "", 0, err
	}
	return sum, size, nil
}

// Path returns where a digest's content lives (two-char fan-out dirs).
func (s *Store) Path(sum string) string {
	if len(sum) < 2 {
		return filepath.Join(s.root, fmt.Sprintf("invalid-%s", sum))
	}
	return filepath.Join(s.root, sum[:2], sum)
}
