package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestCollectionBrowsingUsesPagedSummariesAndScopedDetails(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	item, err := client.Call(ctx, c, CreateLibraryItem, CreateLibraryItemInput{Body: Strict[library.Item]{Value: library.Item{Kind: "video", Title: "Summary title"}}})
	if err != nil {
		t.Fatal(err)
	}
	collection, err := client.Call(ctx, c, CreateLibraryCollection, CreateLibraryCollectionInput{Body: Strict[library.Collection]{Value: library.Collection{Kind: "playlist", Title: "Summary collection", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	if collection.Snapshot == nil || collection.Snapshot.ID <= 0 {
		t.Fatalf("create response omitted snapshot ID: %+v", collection)
	}
	for range 2 {
		previousID := collection.Snapshot.ID
		collection, err = client.Call(ctx, c, EditLibraryCollection, CollectionEditInput{ID: collection.ID, Body: Strict[library.CollectionEdit]{Value: library.CollectionEdit{ExpectedRevision: collection.Revision, Title: collection.Title, Entries: collection.Snapshot.Entries}}})
		if err != nil {
			t.Fatal(err)
		}
		if collection.Snapshot == nil || collection.Snapshot.ID <= previousID {
			t.Fatalf("edit response omitted new snapshot ID: %+v", collection)
		}
		stored, err := client.Call(ctx, c, GetLibraryCollection, LibraryIDInput{ID: collection.ID})
		if err != nil || stored.Snapshot == nil || stored.Snapshot.ID != collection.Snapshot.ID {
			t.Fatalf("edit response differs from committed snapshot: %+v %v", stored, err)
		}
	}
	summaries, err := decoded[[]library.CollectionSummary](client.Call(ctx, c, ListLibraryCollections, LibraryCollectionsInput{LibraryFilters: LibraryFilters{Page: paged(100, 0)}}))
	if err != nil || len(summaries) != 1 || summaries[0].Snapshot == nil || summaries[0].Snapshot.EntryCount != 2 {
		t.Fatalf("list summaries: %+v %v", summaries, err)
	}
	page, err := decoded[[]library.SnapshotSummary](client.Call(ctx, c, ListLibraryCollectionSnapshots, SnapshotsInput{ID: collection.ID, Page: paged(1, 0)}))
	if err != nil || len(page) != 1 || page[0].ID <= 0 || page[0].EntryCount != 2 {
		t.Fatalf("history summaries: %+v %v", page, err)
	}
	next, err := decoded[[]library.SnapshotSummary](client.Call(ctx, c, ListLibraryCollectionSnapshots, SnapshotsInput{ID: collection.ID, Page: paged(1, 1)}))
	if err != nil || len(next) != 1 || next[0].ID >= page[0].ID {
		t.Fatalf("history continuation: %+v %v", next, err)
	}
	detail, err := client.Call(ctx, c, GetLibraryCollectionSnapshot, SnapshotInput{ID: collection.ID, SnapshotID: page[0].ID})
	if err != nil || len(detail.Entries) != 2 || detail.ID != page[0].ID {
		t.Fatalf("snapshot detail: %+v %v", detail, err)
	}
	other, err := client.Call(ctx, c, CreateLibraryCollection, CreateLibraryCollectionInput{Body: Strict[library.Collection]{Value: library.Collection{Kind: "list", Title: "Another"}}})
	if err != nil {
		t.Fatal(err)
	}
	if other.Snapshot == nil || other.Snapshot.ID <= 0 {
		t.Fatalf("empty collection response omitted snapshot ID: %+v", other)
	}
	if _, err = client.Call(ctx, c, GetLibraryCollectionSnapshot, SnapshotInput{ID: other.ID, SnapshotID: page[0].ID}); err == nil {
		t.Fatal("snapshot detail crossed collection boundary")
	}
	full, err := decoded[[]library.Collection](client.Call(ctx, c, ListLibraryCollections, LibraryCollectionsInput{LibraryFilters: LibraryFilters{Q: `"Summary collection"`, Page: paged(100, 0)}, Projection: "full"}))
	if err != nil || len(full) != 1 || full[0].Snapshot == nil || len(full[0].Snapshot.Entries) != 2 {
		t.Fatalf("full list interface lost entries: %+v %v", full, err)
	}
	history, err := decoded[[]library.Snapshot](client.Call(ctx, c, ListLibraryCollectionSnapshots, SnapshotsInput{ID: collection.ID, Projection: "full"}))
	if err != nil || len(history) != 3 || len(history[2].Entries) != 2 {
		t.Fatalf("full history interface lost snapshots: %+v %v", history, err)
	}
	response := authed(t, s, http.MethodGet, "/v1/library/collections?q=Summary", "")
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
	first, err := client.Call(ctx, c, CreateLibraryItem, CreateLibraryItemInput{Body: Strict[library.Item]{Value: library.Item{Kind: "book", Title: "First"}}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.Call(ctx, c, CreateLibraryItem, CreateLibraryItemInput{Body: Strict[library.Item]{Value: library.Item{Kind: "video", Title: "Second"}}})
	if err != nil {
		t.Fatal(err)
	}
	items, err := client.Call(ctx, c, SummarizeLibraryItems, SummarizeLibraryItemsInput{Body: Strict[library.ItemSummaryRequest]{Value: library.ItemSummaryRequest{IDs: []string{second.ID, "missing", first.ID, second.ID}}}})
	if err != nil || len(items) != 2 || items[0].ID != second.ID || items[1].ID != first.ID || items[0].Title != "Second" || items[0].Kind != "video" || items[0].Source != "manual" {
		t.Fatalf("batch summaries: %+v %v", items, err)
	}
	items, err = client.Call(ctx, c, SummarizeLibraryItems, SummarizeLibraryItemsInput{})
	if err != nil || len(items) != 0 {
		t.Fatalf("empty summaries: %+v %v", items, err)
	}
	for _, body := range []string{
		`{"ids":[""]}`,
		`{"ids":[` + strings.TrimSuffix(strings.Repeat(`"id",`, 51), ",") + `]}`,
		`{"ids":[],"unknown":true}`,
	} {
		response := authed(t, s, http.MethodPost, "/v1/library/items/summaries", body)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid summary request accepted: %s %d", body, response.Code)
		}
	}
}

func authed(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	token, err := Tokens(s.dataDir).New("raw-"+rand.Text(), tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}
