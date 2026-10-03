package store_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func libraryItem(external string) library.Item {
	identity := library.Identity{Source: "youtube", Account: "owner", ExternalID: external}
	return library.Item{Identity: identity, ID: library.StableID("item", identity), Kind: "video", Title: "A careful voyage", Provider: "youtube", ProviderID: external}
}

func TestLibraryImportKeepsObservationsAndSnapshots(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("video")
	activity := library.Activity{Identity: library.Identity{Source: "youtube", Account: "owner", ExternalID: "watch1"}, ItemID: item.ID, Kind: "watch", Title: item.Title, Occurred: library.Date{Precision: "day", Value: "2026-10-02"}}
	collection := library.Collection{Identity: library.Identity{Source: "youtube", Account: "owner", ExternalID: "playlist"}, Kind: "playlist", Title: "To watch", Snapshot: &library.Snapshot{ExternalID: "export1", Completeness: "partial", Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}}
	batch := library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{activity}, Collections: []library.Collection{collection}}
	got, err := st.ImportLibrary(ctx, batch)
	if err != nil {
		t.Fatal(err)
	}
	if got.Items != 1 || got.Activity != 1 || got.Collections != 1 {
		t.Fatalf("counts: %+v", got)
	}
	got, err = st.ImportLibrary(ctx, batch)
	if err != nil {
		t.Fatal(err)
	}
	if got.Items != 0 || got.Activity != 0 || got.Collections != 0 {
		t.Fatalf("duplicate counts: %+v", got)
	}
	events, err := st.ListLibraryActivity(ctx, library.ListOptions{Since: "2026-10-02", Until: "2026-10-03"})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Occurred != activity.Occurred {
		t.Fatalf("precision lost: %+v", events)
	}
	id := library.StableID("collection", collection.Identity)
	snapshots, err := st.LibraryCollectionSnapshots(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || len(snapshots[0].Entries) != 2 || snapshots[0].Captured.Precision != "unknown" {
		t.Fatalf("snapshot loss: %+v", snapshots)
	}
	collection.Snapshot = &library.Snapshot{ExternalID: "export2", Completeness: "complete", Entries: []library.Entry{}}
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Collections: []library.Collection{collection}}); err != nil {
		t.Fatal(err)
	}
	snapshots, err = st.LibraryCollectionSnapshots(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 || len(snapshots[0].Entries) != 0 || len(snapshots[1].Entries) != 2 {
		t.Fatalf("snapshots overwritten: %+v", snapshots)
	}
	fresh := libraryItem("rollback")
	collection.Snapshot.Entries = []library.Entry{{ItemID: item.ID, Position: 0}}
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{fresh}, Collections: []library.Collection{collection}}); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("want snapshot conflict, got %v", err)
	}
	if _, err = st.LibraryItem(ctx, fresh.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("batch did not roll back: %v", err)
	}
}

func TestLibraryReplayConflictsCaptureOrderAndSearchModes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("quiet")
	item.Title = "Quiet ocean"
	item.Creators = []string{"Named creator"}
	item.Provenance = library.Provenance{RawRef: "youtube/history.json", Locator: "watch:1"}
	second := libraryItem("forest")
	second.Title = "Quiet forest"
	event := library.Activity{Identity: library.Identity{Source: "netflix", Account: "owner", ExternalID: "observation"}, ItemID: item.ID, Kind: "watch", Occurred: library.Date{Precision: "day", Value: "2026-10-02"}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item, second}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	partial := libraryItem("quiet")
	partial.Title = partial.ProviderID
	partial.Provenance = library.Provenance{RawRef: "youtube/playlist.csv", Locator: "entry:1"}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{partial}}); err != nil {
		t.Fatal(err)
	}
	richer, err := st.LibraryItem(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if richer.Title != "Quiet ocean" || len(richer.Creators) != 1 || len(richer.Evidence) != 2 {
		t.Fatalf("partial playlist erased video metadata: %+v", richer)
	}
	event.Occurred.Value = "2026-10-01"
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{event}}); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("changed event silently accepted: %v", err)
	}
	for _, test := range []struct {
		match string
		count int
	}{{"any", 2}, {"all", 1}, {"phrase", 1}} {
		results, err := st.SearchLibrary(ctx, library.ListOptions{Query: "quiet ocean", Kind: "item", Match: test.match})
		if err != nil {
			t.Fatal(err)
		}
		if len(results.Items) != test.count || len(results.Activity) != 0 {
			t.Fatalf("%s: %+v", test.match, results)
		}
	}
	collection := library.Collection{Identity: library.Identity{Source: "youtube", Account: "owner", ExternalID: "dated"}, Kind: "playlist", Title: "Dated", Snapshot: &library.Snapshot{ExternalID: "new", Captured: library.Date{Precision: "day", Value: "2026-10-02"}, Completeness: "complete", Entries: []library.Entry{}}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Collections: []library.Collection{collection}}); err != nil {
		t.Fatal(err)
	}
	collection.Snapshot.ExternalID = "old"
	collection.Snapshot.Captured.Value = "2026-10-01"
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Collections: []library.Collection{collection}}); err != nil {
		t.Fatal(err)
	}
	got, err := st.LibraryCollection(ctx, library.StableID("collection", collection.Identity))
	if err != nil {
		t.Fatal(err)
	}
	if got.Snapshot == nil || got.Snapshot.ExternalID != "new" {
		t.Fatalf("old import became current: %+v", got)
	}
	collection.Snapshot.Provenance.Locator = "relocated input"
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Collections: []library.Collection{collection}}); err != nil {
		t.Fatalf("provenance relocation broke replay: %v", err)
	}
}
func TestLibraryPersonalEditsAreRevisionedAndImportSafe(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("state")
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := st.SetLibraryState(ctx, item.ID, library.StateEdit{Status: "seen", Favorite: true, Progress: 3, ProgressUnit: "episodes"})
			results <- err
		})
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, library.ErrConflict):
			conflict++
		default:
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent edit: success=%d conflict=%d", success, conflict)
	}
	item.Title = "Updated provider title"
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	got, err := st.LibraryItem(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.State.Favorite || got.State.Revision != 1 || got.Title != item.Title {
		t.Fatalf("import changed state: %+v", got)
	}
	if _, err = st.SetLibraryState(ctx, item.ID, library.StateEdit{ExpectedRevision: 1, Status: "paused", Notes: "Return later"}); err != nil {
		t.Fatal(err)
	}
	history, err := st.LibraryStateHistory(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 || !history[1].Favorite {
		t.Fatalf("state history: %+v", history)
	}
	personal, err := st.CreateLibraryCollection(ctx, library.Collection{Identity: library.Identity{Source: "manual", Account: "owner", ExternalID: "mine"}, Kind: "list", Title: "My list", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}, {ItemID: item.ID, Position: 1}}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = st.EditLibraryCollection(ctx, personal.ID, library.CollectionEdit{ExpectedRevision: 0, Title: "Stale"}); !errors.Is(err, library.ErrConflict) {
		t.Fatalf("stale edit: %v", err)
	}
	if _, err = st.EditLibraryCollection(ctx, personal.ID, library.CollectionEdit{ExpectedRevision: 1, Title: "Empty list", Entries: []library.Entry{}}); err != nil {
		t.Fatal(err)
	}
	snapshots, err := st.LibraryCollectionSnapshots(ctx, personal.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 || len(snapshots[1].Entries) != 2 {
		t.Fatalf("personal snapshots lost: %+v", snapshots)
	}
}

func TestLibraryItemSearchMatchesMetadataAndPersonalState(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("arrival")
	item.Title = "Arrival"
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetLibraryState(ctx, item.ID, library.StateEdit{Notes: "Clever story", Tags: []string{"weekend"}}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		query, match string
		count        int
	}{{"arrival clever weekend", "all", 1}, {"arrival missing", "all", 0}, {"clever missing", "any", 1}, {"clever story", "phrase", 1}, {"story clever", "phrase", 0}} {
		result, err := st.SearchLibrary(ctx, library.ListOptions{Query: test.query, Match: test.match, Kind: "item"})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Items) != test.count {
			t.Errorf("%s %q: got %d want %d", test.match, test.query, len(result.Items), test.count)
		}
	}
}

func TestLibraryPublishedPagesAndStandaloneFilesAreSearchable(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	page := library.Page{Identity: library.Identity{Source: "brain", Account: "vault", ExternalID: "watching"}, Path: "watching.md", Title: "Watching", Body: "A short note", Answers: []string{"Which moon documentary should I watch?"}}
	if _, err := st.PublishLibraryPages(ctx, "brain", "vault", []library.Page{page}); err != nil {
		t.Fatal(err)
	}
	found, err := st.SearchLibrary(ctx, library.ListOptions{Query: "moon"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Pages) != 1 || found.Items == nil || found.Activity == nil {
		t.Fatalf("search contract: %+v", found)
	}
	if _, err = st.PublishLibraryPages(ctx, "brain", "vault", []library.Page{}); err != nil {
		t.Fatal(err)
	}
	found, err = st.SearchLibrary(ctx, library.ListOptions{Query: "moon"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Pages) != 0 {
		t.Fatal("deleted publication remains searchable")
	}
	file := library.File{Identity: library.Identity{Source: "manual", Account: "owner", ExternalID: "document"}, SHA256: strings.Repeat("a", 64), Filename: "paper.txt", MimeType: "text/plain", SizeBytes: 12}
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: []library.File{file}}); err != nil {
		t.Fatal(err)
	}
	known, err := st.KnownAttachment(ctx, file.SHA256)
	if err != nil || !known {
		t.Fatalf("standalone digest not fetchable: %v %v", known, err)
	}
	blobs, err := st.ListBlobs(ctx, store.ListBlobsOpts{Source: "manual", Statuses: []string{store.StatusPending}})
	if err != nil {
		t.Fatal(err)
	}
	if len(blobs) != 1 || blobs[0].SHA256 != file.SHA256 || blobs[0].Messages != 0 {
		t.Fatalf("standalone extraction queue: %+v", blobs)
	}
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: file.SHA256, Text: "Quasar evidence", Status: "ok", Extractor: "text"}); err != nil {
		t.Fatal(err)
	}
	found, err = st.SearchLibrary(ctx, library.ListOptions{Query: "paper quasar", Match: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if len(found.Files) != 1 {
		t.Fatalf("extracted content missing: %+v", found)
	}
}

func TestLibraryAttachmentQueryMatchesAcrossFilenameAndText(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	id, err := st.InsertMessage(ctx, msg("mail", "file-message", store.Message{Body: "A document"}))
	if err != nil {
		t.Fatal(err)
	}
	sum := strings.Repeat("b", 64)
	if err = st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "red-bird.txt", MimeType: "text/plain", SizeBytes: 20, SHA256: sum}); err != nil {
		t.Fatal(err)
	}
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "Blue meadow", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		query, match string
		count        int
	}{{"red-bird.txt", "all", 1}, {"red violet", "any", 1}, {"red blue", "all", 1}, {"red violet", "all", 0}, {"red bird", "phrase", 1}, {"bird red", "phrase", 0}} {
		files, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: test.query, Match: test.match, Source: "mail"})
		if err != nil {
			t.Fatal(err)
		}
		if len(files) != test.count {
			t.Errorf("%s %q: got %d want %d", test.match, test.query, len(files), test.count)
		}
	}
}
