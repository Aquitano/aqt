// Package scratch owns locked, disposable workspaces shared by file readers.
package scratch

import (
	"cmp"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/gofrs/flock"
)

// Workspace keeps its directory locked until Close removes its contents.
type Workspace struct {
	Path string
	lock *flock.Flock
}

// New requires an existing base directory; empty uses the system temp directory.
func New(base string, log *slog.Logger) (*Workspace, error) {
	if base == "" {
		base = os.TempDir()
	}
	root := filepath.Join(base, "aqt-attic")
	// The base must already exist so the scanner can check its volume before
	// writing. Creating missing parents could bypass that check on Windows.
	if err := os.Mkdir(root, 0o700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("temporary directory is not a directory: %s", root)
	}
	if err := removeStaleWorkspaces(root); err != nil {
		cmp.Or(log, slog.New(slog.DiscardHandler)).Warn("could not clean abandoned workspaces", "temp", root, "err", err)
	}
	dir, err := os.MkdirTemp(root, "scan-")
	if err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, ".lock"))
	if err := lock.Lock(); err != nil {
		return nil, errors.Join(err, os.RemoveAll(dir))
	}
	return &Workspace{Path: dir, lock: lock}, nil
}

func (w *Workspace) Close() error {
	// Keep the marker until every copy is gone, so a later sweep can retry
	// when permissions or an open Windows handle prevent deletion.
	err := w.removeContents()
	if err := errors.Join(err, w.lock.Close()); err != nil {
		return err
	}
	return os.RemoveAll(w.Path)
}

func (w *Workspace) removeContents() error {
	entries, err := os.ReadDir(w.Path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == ".lock" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(w.Path, entry.Name())); err != nil {
			return err
		}
	}
	return nil
}

var workspaceName = regexp.MustCompile(`^scan-\d+$`)

func removeStaleWorkspaces(root string) error {
	sweep := flock.New(filepath.Join(root, ".cleanup.lock"))
	locked, err := sweep.TryLock()
	if err != nil || !locked {
		return err
	}
	defer sweep.Close()
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var failures []error
	for _, entry := range entries {
		if !entry.IsDir() || !workspaceName.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < 24*time.Hour {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		marker := filepath.Join(dir, ".lock")
		info, err = os.Lstat(marker)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		lock := flock.New(marker, flock.SetFlag(os.O_RDONLY))
		locked, err := lock.TryLock()
		if err != nil || !locked {
			_ = lock.Close()
			continue
		}
		workspace := Workspace{Path: dir, lock: lock}
		if err := workspace.Close(); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
