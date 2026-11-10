package catalog

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type emptyReader struct{}

func (emptyReader) Search(context.Context, string, store.SearchOpts) ([]store.Message, error) {
	return []store.Message{}, nil
}
func (emptyReader) SearchLibrary(context.Context, library.ListOptions) (library.SearchResult, error) {
	return library.SearchResult{Coverage: []string{}}, nil
}
func (emptyReader) AttachmentLibrary(context.Context, store.AttachmentFilter) ([]store.LibraryFile, error) {
	return []store.LibraryFile{}, nil
}

func TestFindRejectsConflictingScopeAndExplainsDates(t *testing.T) {
	ctx := context.Background()
	for _, options := range []library.ListOptions{{Kind: "movie"}, {Account: "owner"}} {
		_, err := Find(ctx, emptyReader{}, nil, "film", store.SearchOpts{From: "alice", Limit: 20}, options)
		if !errors.Is(err, ErrFilters) {
			t.Fatalf("conflicting scope %+v: %v", options, err)
		}
	}
	result, err := Find(ctx, emptyReader{}, nil, "film", store.SearchOpts{Limit: 20}, library.ListOptions{Kind: "movie", Since: "2026-01-01"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(result.Coverage, " "), "without date filtering") {
		t.Fatalf("missing date coverage: %+v", result.Coverage)
	}
}

type disks struct {
	err   error
	calls int
}

func (d *disks) SearchDisks(context.Context, string, int, int) (view.SearchResult, error) {
	d.calls++
	return view.SearchResult{Entries: []view.Place{{Display: `E:\Backups\minecraft.zip`}}}, d.err
}

func TestFindAddsFilesOnDisksUnlessTheSearchIsScopedElsewhere(t *testing.T) {
	ctx := context.Background()
	found := &disks{}
	result, err := Find(ctx, emptyReader{}, found, "minecraft", store.SearchOpts{Limit: 20}, library.ListOptions{})
	if err != nil || len(result.Disks.Entries) != 1 {
		t.Fatalf("unscoped search: %+v, %v", result.Disks, err)
	}
	for name, scoped := range map[string]func() (Result, error){
		"sender": func() (Result, error) {
			return Find(ctx, emptyReader{}, found, "minecraft", store.SearchOpts{From: "alice", Limit: 20}, library.ListOptions{})
		},
		"kind": func() (Result, error) {
			return Find(ctx, emptyReader{}, found, "minecraft", store.SearchOpts{Limit: 20}, library.ListOptions{Kind: "movie"})
		},
		"date": func() (Result, error) {
			return Find(ctx, emptyReader{}, found, "minecraft", store.SearchOpts{Limit: 20}, library.ListOptions{Since: "2026-01-01"})
		},
	} {
		if result, err := scoped(); err != nil || len(result.Disks.Entries) != 0 {
			t.Fatalf("%s-scoped search returned files on disks: %+v, %v", name, result.Disks, err)
		}
	}
	if found.calls != 1 {
		t.Fatalf("the catalogue was searched %d times, want once", found.calls)
	}

	// A catalogue that cannot answer costs its group, not the archive's results.
	result, err = Find(ctx, emptyReader{}, &disks{err: errors.New("not ready")}, "minecraft", store.SearchOpts{Limit: 20}, library.ListOptions{})
	if err != nil || len(result.Disks.Entries) != 0 || !strings.Contains(strings.Join(result.Coverage, " "), "not ready") {
		t.Fatalf("failing catalogue: %+v, coverage %v, %v", result.Disks, result.Coverage, err)
	}
}
