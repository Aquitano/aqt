// Package export opens an import input the way every exporter ships one: a
// zip, the directory it unpacks to, or a single file taken out of it.
package export

import (
	"archive/zip"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Export is an opened input. FS is nil for a single file, which the importer
// reads from its path; otherwise it is the zip's contents or the directory.
type Export struct {
	FS    fs.FS
	Dir   bool
	close func() error
}

// Open treats a path ending in .zip as a zip and any other file as a single
// file.
func Open(path string) (Export, error) {
	info, err := os.Stat(path)
	switch {
	case err != nil:
		return Export{}, err
	case info.IsDir():
		return Export{FS: os.DirFS(path), Dir: true}, nil
	case strings.EqualFold(filepath.Ext(path), ".zip"):
		zr, err := zip.OpenReader(path)
		if err != nil {
			return Export{}, err
		}
		return Export{FS: &zr.Reader, close: zr.Close}, nil
	}
	return Export{}, nil
}

func (e Export) Close() error {
	if e.close == nil {
		return nil
	}
	return e.close()
}
