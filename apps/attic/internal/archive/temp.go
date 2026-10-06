package archive

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/gofrs/flock"
)

type tempWorkspace struct {
	path string
	lock *flock.Flock
}

func newTempWorkspace(base string) (*tempWorkspace, error) {
	if base == "" {
		base = os.TempDir()
	}
	root := filepath.Join(base, "aqt-attic")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("archive temporary directory is not a directory: %s", root)
	}
	if err := removeStaleWorkspaces(root); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(root, "scan-")
	if err != nil {
		return nil, err
	}
	lock := flock.New(filepath.Join(dir, ".lock"))
	if err := lock.Lock(); err != nil {
		return nil, errors.Join(err, os.RemoveAll(dir))
	}
	return &tempWorkspace{path: dir, lock: lock}, nil
}

func (w *tempWorkspace) Close() error {
	if err := w.lock.Close(); err != nil {
		return err
	}
	return os.RemoveAll(w.path)
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
		if err := lock.Close(); err != nil {
			return err
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
	}
	return nil
}
