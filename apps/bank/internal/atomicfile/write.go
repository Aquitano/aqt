// Package atomicfile atomically replaces credential files with owner-only access.
package atomicfile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/natefinch/atomic"
)

func Write(path string, reader io.Reader) error {
	// Tighten the old file before atomic.WriteFile copies its mode to the new
	// file, so fresh credentials are never installed with broader permissions.
	if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// New files start at 0600. The library fsyncs their contents, but the
	// containing directory still needs syncing after replacement.
	if err := atomic.WriteFile(path, reader); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
