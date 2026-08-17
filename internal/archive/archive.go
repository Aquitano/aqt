// Package archive keeps raw inputs exactly as received so every import can be
// redone against original data.
package archive

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
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

	if err := os.MkdirAll(filepath.Join(archiveDir, source), 0o755); err != nil {
		return "", err
	}
	rel := filepath.Join(source, prefix+"-"+filepath.Base(path))
	dest := filepath.Join(archiveDir, rel)
	if _, err := os.Stat(dest); err == nil {
		return rel, nil
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	out, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, src); err != nil {
		out.Close()
		return "", err
	}
	return rel, out.Close()
}

// Write stores in-memory content (e.g. one fetched Gmail message) under
// <archiveDir>/<source>/<name> and returns the relative reference.
func Write(archiveDir, source, name string, data []byte) (string, error) {
	if err := os.MkdirAll(filepath.Join(archiveDir, source), 0o755); err != nil {
		return "", err
	}
	rel := filepath.Join(source, name)
	dest := filepath.Join(archiveDir, rel)
	if _, err := os.Stat(dest); err == nil {
		return rel, nil
	}
	return rel, os.WriteFile(dest, data, 0o644)
}
