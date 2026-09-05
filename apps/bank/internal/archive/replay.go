package archive

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Entry is one archived raw input, replayable through its importer.
type Entry struct {
	// Ref is the reference relative to the archive root — the same value
	// imports store in raw_ref.
	Ref string
	// Name is the input's original filename, content-hash prefix stripped.
	Name string
}

// hashPrefix is the content-hash prefix Copy (and the merged-shard writer in
// aichat) put before the original filename.
var hashPrefix = regexp.MustCompile(`^[0-9a-f]{12}-`)

// List returns every archived input under a source, oldest archive copy
// first, so a replay applies exports in arrival order and the newest wins
// wherever they disagree. A source that was never archived lists as empty
// rather than failing: the archive directory is created lazily on first
// write.
func List(archiveDir, source string) ([]Entry, error) {
	if err := ValidSource(source); err != nil {
		return nil, err
	}
	dir := filepath.Join(archiveDir, source)
	des, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	type dated struct {
		e  Entry
		at time.Time
	}
	var all []dated
	for _, de := range des {
		if de.IsDir() || strings.HasPrefix(de.Name(), ".partial-") {
			continue
		}
		info, err := de.Info()
		if err != nil {
			return nil, err
		}
		all = append(all, dated{
			e:  Entry{Ref: filepath.Join(source, de.Name()), Name: hashPrefix.ReplaceAllString(de.Name(), "")},
			at: info.ModTime(),
		})
	}
	sort.Slice(all, func(i, j int) bool {
		if !all[i].at.Equal(all[j].at) {
			return all[i].at.Before(all[j].at)
		}
		return all[i].e.Ref < all[j].e.Ref
	})
	out := make([]Entry, len(all))
	for i, d := range all {
		out[i] = d.e
	}
	return out, nil
}

// Stage copies one archived input into dir under its original name, handing
// an importer back exactly the file it once saw: importers that derive
// identity from the filename (a Claude Code session id, a WhatsApp chat name)
// need the name, and re-archiving the staged copy is a no-op because its
// content hashes back to the reference that already exists. dir must hold
// only this one staging copy — original names are not unique across exports.
func Stage(archiveDir string, e Entry, dir string) (string, error) {
	src, err := os.Open(filepath.Join(archiveDir, e.Ref))
	if err != nil {
		return "", err
	}
	defer src.Close()
	dest := filepath.Join(dir, e.Name)
	f, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, src)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(dest)
		return "", err
	}
	return dest, nil
}
