// Package export opens an input the way every exporter ships one: a zip, or a
// single file taken out of it. A directory reaches a source as the zip Pack
// made of it.
package export

import (
	"archive/zip"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
)

// Export is an opened input. FS is nil for a single file, which the source
// reads from raw.Path; otherwise it is the zip's contents.
type Export struct {
	FS    fs.FS
	close func() error
}

// Open treats an input whose name ends in .zip as a zip and any other as a
// single file.
func Open(raw ingest.Raw) (Export, error) {
	if !IsZip(raw.Name) {
		return Export{}, nil
	}
	zr, err := zip.OpenReader(raw.Path)
	if err != nil {
		return Export{}, err
	}
	return Export{FS: &zr.Reader, close: zr.Close}, nil
}

func IsZip(name string) bool { return strings.EqualFold(filepath.Ext(name), ".zip") }

func (e Export) Close() error {
	if e.close == nil {
		return nil
	}
	return e.close()
}

// Pack writes a directory as a zip in walk order, with each file's
// modification time, so packing an unchanged directory twice yields the same
// bytes and so the same raw input.
func Pack(root string, w io.Writer) error {
	zw := zip.NewWriter(w)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		dst, err := zw.CreateHeader(&zip.FileHeader{Name: filepath.ToSlash(rel), Method: zip.Deflate, Modified: info.ModTime().UTC()})
		if err != nil {
			return err
		}
		src, err := os.Open(path)
		if err != nil {
			return err
		}
		_, err = io.Copy(dst, src)
		if closeErr := src.Close(); err == nil {
			err = closeErr
		}
		return err
	})
	if err != nil {
		return err
	}
	return zw.Close()
}
