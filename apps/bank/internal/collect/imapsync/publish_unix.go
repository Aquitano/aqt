//go:build !windows

package imapsync

import (
	"errors"
	"os"
	"path/filepath"
)

func publishMessage(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func publishBatch(dir string) error {
	if err := syncDirectory(dir); err != nil {
		return err
	}
	if err := os.Rename(dir, dir+"-ready"); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(dir))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
