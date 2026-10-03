package catalog

import (
	"context"
	"errors"
	"strings"
	"testing"

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
		_, err := Find(ctx, emptyReader{}, "film", store.SearchOpts{From: "alice", Limit: 20}, options)
		if !errors.Is(err, ErrFilters) {
			t.Fatalf("conflicting scope %+v: %v", options, err)
		}
	}
	result, err := Find(ctx, emptyReader{}, "film", store.SearchOpts{Limit: 20}, library.ListOptions{Kind: "movie", Since: "2026-01-01"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(result.Coverage, " "), "without date filtering") {
		t.Fatalf("missing date coverage: %+v", result.Coverage)
	}
}
