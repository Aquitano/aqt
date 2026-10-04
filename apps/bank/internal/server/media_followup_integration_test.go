package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
)

func TestCollectionBrowsingUsesPagedSummariesAndScopedDetails(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	item, err := c.CreateLibraryItem(ctx, library.Item{Kind: "video", Title: "Summary title"})
	if err != nil {
		t.Fatal(err)
	}
	collection, err := c.CreateLibraryCollection(ctx, library.Collection{Kind: "playlist", Title: "Summary collection", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}})
	if err != nil {
		t.Fatal(err)
	}
	if collection.Snapshot == nil || collection.Snapshot.ID <= 0 {
		t.Fatalf("create response omitted snapshot ID: %+v", collection)
	}
	for range 2 {
		previousID := collection.Snapshot.ID
		collection, err = c.EditLibraryCollection(ctx, collection.ID, library.CollectionEdit{ExpectedRevision: collection.Revision, Title: collection.Title, Entries: collection.Snapshot.Entries})
		if err != nil {
			t.Fatal(err)
		}
		if collection.Snapshot == nil || collection.Snapshot.ID <= previousID {
			t.Fatalf("edit response omitted new snapshot ID: %+v", collection)
		}
		stored, err := c.LibraryCollection(ctx, collection.ID)
		if err != nil || stored.Snapshot == nil || stored.Snapshot.ID != collection.Snapshot.ID {
			t.Fatalf("edit response differs from committed snapshot: %+v %v", stored, err)
		}
	}
	summaries, err := c.ListLibraryCollectionSummaries(ctx, library.ListOptions{})
	if err != nil || len(summaries) != 1 || summaries[0].Snapshot == nil || summaries[0].Snapshot.EntryCount != 2 {
		t.Fatalf("list summaries: %+v %v", summaries, err)
	}
	page, err := c.LibraryCollectionSnapshotSummaries(ctx, collection.ID, library.ListOptions{Limit: 1})
	if err != nil || len(page) != 1 || page[0].ID <= 0 || page[0].EntryCount != 2 {
		t.Fatalf("history summaries: %+v %v", page, err)
	}
	next, err := c.LibraryCollectionSnapshotSummaries(ctx, collection.ID, library.ListOptions{Limit: 1, Offset: 1})
	if err != nil || len(next) != 1 || next[0].ID >= page[0].ID {
		t.Fatalf("history continuation: %+v %v", next, err)
	}
	detail, err := c.LibraryCollectionSnapshot(ctx, collection.ID, page[0].ID)
	if err != nil || len(detail.Entries) != 2 || detail.ID != page[0].ID {
		t.Fatalf("snapshot detail: %+v %v", detail, err)
	}
	other, err := c.CreateLibraryCollection(ctx, library.Collection{Kind: "list", Title: "Another"})
	if err != nil {
		t.Fatal(err)
	}
	if other.Snapshot == nil || other.Snapshot.ID <= 0 {
		t.Fatalf("empty collection response omitted snapshot ID: %+v", other)
	}
	if _, err = c.LibraryCollectionSnapshot(ctx, other.ID, page[0].ID); err == nil {
		t.Fatal("snapshot detail crossed collection boundary")
	}
	full, err := c.ListLibraryCollections(ctx, library.ListOptions{Query: "Summary collection", Match: "phrase"})
	if err != nil || len(full) != 1 || full[0].Snapshot == nil || len(full[0].Snapshot.Entries) != 2 {
		t.Fatalf("full list interface lost entries: %+v %v", full, err)
	}
	history, err := c.LibraryCollectionSnapshots(ctx, collection.ID)
	if err != nil || len(history) != 3 || len(history[2].Entries) != 2 {
		t.Fatalf("full history interface lost snapshots: %+v %v", history, err)
	}
	response := httptest.NewRecorder()
	s.handleMediaCollections(response, httptest.NewRequest(http.MethodGet, "/v1/library/collections?q=Summary", nil))
	var raw []struct {
		Snapshot map[string]json.RawMessage `json:"snapshot"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &raw); err != nil || len(raw) != 1 {
		t.Fatalf("summary response: %s %v", response.Body.String(), err)
	}
	if _, present := raw[0].Snapshot["entries"]; present {
		t.Fatalf("summary loaded membership: %s", response.Body.String())
	}
}

func TestLibraryItemSummaryBatchIsBoundedAndOrdered(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	first, err := c.CreateLibraryItem(ctx, library.Item{Kind: "book", Title: "First"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.CreateLibraryItem(ctx, library.Item{Kind: "video", Title: "Second"})
	if err != nil {
		t.Fatal(err)
	}
	items, err := c.LibraryItemSummaries(ctx, []string{second.ID, "missing", first.ID, second.ID})
	if err != nil || len(items) != 2 || items[0].ID != second.ID || items[1].ID != first.ID || items[0].Title != "Second" || items[0].Kind != "video" || items[0].Source != "manual" {
		t.Fatalf("batch summaries: %+v %v", items, err)
	}
	items, err = c.LibraryItemSummaries(ctx, nil)
	if err != nil || len(items) != 0 {
		t.Fatalf("empty summaries: %+v %v", items, err)
	}
	for _, body := range []string{
		`{"ids":[""]}`,
		`{"ids":[` + strings.TrimSuffix(strings.Repeat(`"id",`, 51), ",") + `]}`,
		`{"ids":[],"unknown":true}`,
	} {
		response := httptest.NewRecorder()
		s.handleMediaItemSummaries(response, httptest.NewRequest(http.MethodPost, "/v1/library/items/summaries", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid summary request accepted: %s %d", body, response.Code)
		}
	}
}
