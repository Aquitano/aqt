package importer

import (
	"io"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/export"
)

// Open reads one input given on a command line: a file as it is, a directory
// packed into one zip so its media comes along, and "-" as standard input.
// The name is what the input is stored under.
func Open(path string) (string, io.ReadCloser, error) {
	if path == "-" {
		return "stdin", io.NopCloser(os.Stdin), nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", nil, err
	}
	name := filepath.Base(filepath.Clean(path))
	if !info.IsDir() {
		f, err := os.Open(path)
		return name, f, err
	}
	r, w := io.Pipe()
	go func() { w.CloseWithError(export.Pack(path, w)) }()
	return name + ".zip", r, nil
}
