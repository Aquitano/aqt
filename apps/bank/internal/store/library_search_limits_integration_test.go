package store_test

import (
	"context"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/jackc/pgx/v5"
)

func TestLibraryOversizedPagesAndNotesRemainSearchable(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	conn, err := pgx.Connect(ctx, storetest.SchemaDSN(t, schema))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	var pageText, notes string
	if err = conn.QueryRow(ctx, `select 'phrase head ' || string_agg('term'||g,' ') || ' suffixneedle' from generate_series(1,300000)g`).Scan(&pageText); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `select 'phrase head ' || string_agg('term'||g,' ') || ' suffixneedle' from generate_series(1,100000)g`).Scan(&notes); err != nil {
		t.Fatal(err)
	}
	page := library.Page{Identity: library.Identity{Source: "brain", Account: "wiki", ExternalID: "large.md"}, Path: "large.md", Title: "Metadata", Body: pageText}
	if _, err = st.PublishLibraryPages(ctx, page.Source, page.Account, []library.Page{page}); err != nil {
		t.Fatalf("accepted page could not be published: %v", err)
	}
	item := libraryItem("large-notes")
	item.Title = "Metadata"
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	if _, err = st.SetLibraryState(ctx, item.ID, library.StateEdit{Notes: notes}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ mode, query string }{{"any", "suffixneedle"}, {"all", "metadata suffixneedle"}, {"phrase", "phrase head"}} {
		result, err := st.SearchLibrary(ctx, library.ListOptions{Query: test.query, Match: test.mode})
		if err != nil || len(result.Pages) != 1 || len(result.Items) != 1 {
			t.Fatalf("oversized %s %q: pages=%d items=%d error=%v", test.mode, test.query, len(result.Pages), len(result.Items), err)
		}
		if result.Pages[0].Body != pageText || result.Items[0].State.Notes != notes {
			t.Fatal("search truncated the preserved text")
		}
	}
}

func TestPersonalCollectionSnapshotFollowsRevisionDespiteClockChanges(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	item := libraryItem("clock-change")
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	collection, err := st.CreateLibraryCollection(ctx, library.Collection{Identity: library.Identity{Source: "manual", Account: "owner", ExternalID: "clock-change"}, Kind: "list", Title: "My list", Snapshot: &library.Snapshot{Entries: []library.Entry{{ItemID: item.ID, Position: 0}}}})
	if err != nil {
		t.Fatal(err)
	}
	storetest.Exec(t, schema, `update library_snapshots set captured='{"precision":"instant","value":"9999-01-01T00:00:00Z"}' where id=$1`, collection.Snapshot.ID)
	updated, err := st.EditLibraryCollection(ctx, collection.ID, library.CollectionEdit{ExpectedRevision: collection.Revision, Title: "Empty", Entries: []library.Entry{}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.LibraryCollection(ctx, collection.ID)
	if err != nil || got.Snapshot == nil || got.Snapshot.ID != updated.Snapshot.ID || len(got.Snapshot.Entries) != 0 {
		t.Fatalf("older revision became current: %+v %v", got, err)
	}
	summaries, err := st.ListLibraryCollectionSummaries(ctx, library.ListOptions{Source: "manual"})
	if err != nil || len(summaries) != 1 || summaries[0].Snapshot == nil || summaries[0].Snapshot.ID != updated.Snapshot.ID || summaries[0].Snapshot.EntryCount != 0 {
		t.Fatalf("summary chose older revision: %+v %v", summaries, err)
	}
}
