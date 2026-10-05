//go:build !windows

package archive

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

func makeArchiveDirectories(path string) error {
	var missing []string
	for dir := path; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(dir); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		missing = append(missing, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	for _, dir := range missing {
		if err := syncDirectory(filepath.Dir(dir)); err != nil {
			return err
		}
	}
	return nil
}

func publishArchiveFile(oldPath, newPath string) error {
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(newPath))
}

func syncArchiveFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
