// Package importtest runs sources through the real importer against a test
// database, so a source's tests see what an import stores.
package importtest

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// Target is an archive on a database of its own with the given kinds.
func Target(t *testing.T, kinds ...importer.Kind) importer.Target {
	t.Helper()
	st := storetest.New(t)
	return On(t, st, kinds...)
}

// On is Target on an existing store.
func On(t *testing.T, st *store.Store, kinds ...importer.Kind) importer.Target {
	t.Helper()
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return importer.Target{Store: st, Blobs: blobs, Kinds: kinds}
}

// Import imports a file or directory the way the CLI does, with options as
// JSON, and returns the raw input with its report and the import's error.
func Import(t *testing.T, target importer.Target, kind, path string, options any) (store.RawInput, error) {
	t.Helper()
	raw, err := json.Marshal(options)
	if err != nil {
		t.Fatal(err)
	}
	if options == nil {
		raw = nil
	}
	name, r, err := importer.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	return importer.Import(context.Background(), target, kind, name, r, raw)
}

// MustImport is Import that fails the test on an error.
func MustImport(t *testing.T, target importer.Target, kind, path string, options any) store.RawInput {
	t.Helper()
	got, err := Import(t, target, kind, path, options)
	if err != nil {
		t.Fatalf("import %s %s: %v", kind, path, err)
	}
	return got
}
