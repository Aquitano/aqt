package importer

import (
	"context"
	"io"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/export"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/inbox"
	"github.com/aquitano/aqt/apps/bank/internal/store"
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

// SweepInbox imports every file waiting in dir/<kind>/ for t's kinds.
func SweepInbox(ctx context.Context, t Target, dir string) (inbox.Result, error) {
	return inbox.Sweep(ctx, dir, t.Kinds.Names(), func(ctx context.Context, kind, path string) (store.RawInput, error) {
		name, r, err := Open(path)
		if err != nil {
			return store.RawInput{}, fail.Op(err)
		}
		defer r.Close()
		return Import(ctx, t, kind, name, r, nil)
	})
}
