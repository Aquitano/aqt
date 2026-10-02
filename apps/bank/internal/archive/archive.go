// Package archive keeps raw inputs exactly as received so every import can be
// redone against original data. Writes are atomic (temp file + rename): a
// partially written file can never be mistaken for a complete archive copy.
package archive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// sourceName is deliberately narrow. A source is both a directory under the
// archive root and a search filter, and on the HTTP import route it arrives
// straight from a query string — anything with a separator, a leading dot or a
// traversal segment could redirect archived bytes out of the archive.
var sourceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// ValidSource reports whether source is safe to use as an archive directory.
// Callers that accept a source from outside (the import API, the --source
// flag) should check it before doing any work.
func ValidSource(source string) error {
	if source == "" {
		return fmt.Errorf("source must not be empty")
	}
	if !sourceName.MatchString(source) || strings.Contains(source, "..") {
		return fmt.Errorf("invalid source %q: use letters, digits, '.', '_' or '-', starting with a letter or digit", source)
	}
	return nil
}

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
	return write(archiveDir, source, name, bytes.NewReader(data))
}

// Replace stores content under <archiveDir>/<source>/<name>, superseding what
// a previous import archived there. It exists for sources whose raw input is
// one growing file re-read on every sync — an AI harness session log, a live
// database snapshot — where Copy would archive the same ever-longer prefix
// over and over; the newest copy contains everything the older ones did, so
// it alone is the raw input. Identical content is a no-op, and the rename is
// atomic: a reader never sees a partial file.
func Replace(archiveDir, source, name string, data []byte) (string, error) {
	if err := ValidSource(source); err != nil {
		return "", err
	}
	if err := ValidName(name); err != nil {
		return "", err
	}
	rel := filepath.Join(source, name)
	if Identical(archiveDir, source, name, data) {
		return rel, nil
	}
	dir := filepath.Join(archiveDir, source)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".partial-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync() // a file at dest is trusted as complete; see write
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(archiveDir, rel)); err != nil {
		return "", err
	}
	return rel, nil
}

// Identical reports whether <archiveDir>/<source>/<name> already holds
// exactly this content. Importers that sync a growing file use it to skip
// re-reading input whose every byte was archived — and, because they archive
// only after a completed ingest, already imported — by an earlier run.
func Identical(archiveDir, source, name string, data []byte) bool {
	path := filepath.Join(archiveDir, source, name)
	// Size first: on a sync most files either match exactly or grew, and the
	// stat spares re-reading the whole archived copy for the grown ones.
	info, err := os.Stat(path)
	if err != nil || info.Size() != int64(len(data)) {
		return false
	}
	existing, err := os.ReadFile(path)
	return err == nil && bytes.Equal(existing, data)
}

// ValidName reports whether name is safe as an archive filename. Names can
// contain externally supplied ids and upload basenames; they must stay a
// single path component. Exported so importers that ingest before archiving
// can refuse a bad name before any rows exist that reference it.
func ValidName(name string) error {
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, "..") {
		return fmt.Errorf("invalid archive name %q", name)
	}
	return nil
}

func write(archiveDir, source, name string, r io.Reader) (string, error) {
	if err := ValidSource(source); err != nil {
		return "", err
	}
	if err := ValidName(name); err != nil {
		return "", err
	}
	return writeAt(archiveDir, filepath.Join(source, name), r)
}

func writeAt(archiveDir, rel string, r io.Reader) (string, error) {
	return writePublished(archiveDir, rel, r, publishArchiveFile, syncArchiveFile)
}

func writePublished(archiveDir, rel string, r io.Reader, publish func(string, string) error, syncExisting func(string) error) (string, error) {
	dir := filepath.Dir(filepath.Join(archiveDir, rel))
	if err := makeArchiveDirectories(dir); err != nil {
		return "", err
	}
	dest := filepath.Join(archiveDir, rel)
	if _, err := os.Stat(dest); err == nil {
		return rel, syncExisting(dest)
	}
	tmp, err := os.CreateTemp(dir, ".partial-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	_, err = io.Copy(tmp, r)
	// fsync before the rename: a file at dest is trusted as complete, so a
	// host crash must not be able to leave a truncated one there.
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := publish(tmp.Name(), dest); err != nil {
		return "", err
	}
	return rel, nil
}
