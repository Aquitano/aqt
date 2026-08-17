// Package archive keeps raw inputs exactly as received so every import can be
// redone against original data. Writes are atomic (temp file + rename): a
// partially written file can never be mistaken for a complete archive copy.
package archive

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Copy stores path under <archiveDir>/<source>/ with a content-hash prefix so
// distinct files with the same name never collide, and returns the reference
// relative to archiveDir. Copying identical content again is a no-op.
func Copy(archiveDir, source, path string) (string, error) {
	src, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer src.Close()
	h := sha256.New()
	if _, err := io.Copy(h, src); err != nil {
		return "", err
	}
	prefix := hex.EncodeToString(h.Sum(nil))[:12]
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return write(archiveDir, source, prefix+"-"+filepath.Base(path), src)
}

// Write stores in-memory content (e.g. one fetched Gmail message) under
// <archiveDir>/<source>/<name> and returns the relative reference.
func Write(archiveDir, source, name string, data []byte) (string, error) {
	return write(archiveDir, source, name, strings.NewReader(string(data)))
}

func write(archiveDir, source, name string, r io.Reader) (string, error) {
	// name can contain externally supplied ids; it must stay a single path
	// component.
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, "..") {
		return "", fmt.Errorf("invalid archive name %q", name)
	}
	dir := filepath.Join(archiveDir, source)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	rel := filepath.Join(source, name)
	dest := filepath.Join(archiveDir, rel)
	if _, err := os.Stat(dest); err == nil {
		return rel, nil // complete by construction: only renamed-in files exist
	}
	tmp, err := os.CreateTemp(dir, ".partial-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, r)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return "", err
	}
	return rel, nil
}
