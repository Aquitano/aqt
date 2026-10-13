// Package atomicfile writes complete files and preserves existing permissions.
package atomicfile

import (
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/natefinch/atomic"
)

func Write(path string, reader io.Reader) error {
	// atomic.WriteFile creates new files with mode 0600, preserves an existing
	// mode and fsyncs contents before replacement. It does not sync the directory.
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
