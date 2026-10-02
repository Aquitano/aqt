//go:build !windows

package archive

import (
	"errors"
	"os"
	"path/filepath"
)

func makeArchiveDirectories(path string) error {
	return os.MkdirAll(path, 0o700)
}

func publishArchiveFile(oldPath, newPath string) error {
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	return syncArchiveParents(filepath.Dir(newPath))
}

func syncArchiveFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return err
	}
	return syncArchiveParents(filepath.Dir(path))
}

func syncArchiveParents(path string) error {
	resolved, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	path = resolved
	for {
		directory, err := os.Open(path)
		if err != nil {
			return err
		}
		if err := errors.Join(directory.Sync(), directory.Close()); err != nil {
			return err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}
