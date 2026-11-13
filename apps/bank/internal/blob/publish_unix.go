//go:build !windows

package blob

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// makeFanOut creates a fan-out directory and syncs the store root, so the
// directory survives a host crash along with the file renamed into it.
func makeFanOut(dir string) error {
	err := os.Mkdir(dir, 0o700)
	if errors.Is(err, fs.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(dir))
}

func publish(oldPath, newPath string) error {
	if err := os.Rename(oldPath, newPath); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(newPath))
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
