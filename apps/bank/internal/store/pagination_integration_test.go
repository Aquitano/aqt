package store_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/find"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// seedIdentical inserts n messages that match a query identically: same words,
// same second, so BM25 scores them the same and sent_at cannot separate them
// either. This is the case that makes paging correct or broken.
func seedIdentical(t *testing.T, st *store.Store, n int) {
	t.Helper()
	ctx := context.Background()
	at := time.Date(2024, 5, 13, 19, 8, 0, 0, time.UTC)
	for i := 0; i < n; i++ {
		if _, err := st.InsertMessage(ctx, store.Message{
			Source: "proton", ExternalID: "dup-" + strings.Repeat("x", i),
			Sender: "alice@example.com", Subject: "quarterly report",
			Body: "the quarterly report is attached", SentAt: at,
		}); err != nil {
			t.Fatal(err)
		}
	}
}

// Paging must return every match exactly once.
//
// This guards the contract, not the plan: with a handful of rows Postgres
// happens to return tied rows consistently, so the test passes even without
// the id tiebreaker. The tiebreaker is there because "happens to" is not a
// guarantee — SQL promises nothing about the order of rows a sort cannot
// separate, and a plan change at archive scale is free to rearrange them
// between one page and the next.
func TestSearchPagesCoverEveryMatchExactlyOnce(t *testing.T) {
	st := storetest.New(t)
	const total, page = 7, 3
	seedIdentical(t, st, total)

	seen := map[string]int{}
	for offset := 0; offset < total+page; offset += page {
		for _, m := range findMessages(t, st, "quarterly", page, offset) {
			seen[m.Ref]++
		}
	}
	if len(seen) != total {
		t.Fatalf("paged over %d distinct messages, want %d", len(seen), total)
	}
	for ref, n := range seen {
		if n != 1 {
			t.Errorf("message %s returned %d times across pages", ref, n)
		}
	}
}

// The same query twice has to produce the same arrangement, or a page is only
// meaningful relative to a ranking that no longer exists. Same caveat as
// above: this passes today either way, and exists so a future change that
// makes the order genuinely unstable is caught here.
func TestSearchOrderIsStableAcrossIdenticalQueries(t *testing.T) {
	st := storetest.New(t)
	seedIdentical(t, st, 10)

	first := findMessages(t, st, "quarterly", 10, 0)
	for i := 0; i < 5; i++ {
		again := findMessages(t, st, "quarterly", 10, 0)
		for j := range first {
			if again[j].Ref != first[j].Ref {
				t.Fatalf("run %d position %d: %s, first run had %s", i, j, again[j].Ref, first[j].Ref)
			}
		}
	}
}

// An offset past the end is an empty page, not an error: that is how a caller
// finds out it has reached the end.
func TestSearchOffsetPastTheEnd(t *testing.T) {
	st := storetest.New(t)
	seedIdentical(t, st, 3)

	if msgs := findMessages(t, st, "quarterly", 10, 50); len(msgs) != 0 {
		t.Fatalf("got %d messages past the end, want none", len(msgs))
	}
}

func findMessages(t *testing.T, st *store.Store, query string, limit, offset int) []search.SearchHit {
	t.Helper()
	found, err := find.Find(t.Context(), st, query, search.All, search.Filters{Kind: search.KindMessage}, limit, offset)
	if err != nil {
		t.Fatal(err)
	}
	return found.Hits
}

func TestContactMessagesPaging(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedIdentical(t, st, 5)
	if _, err := st.CreateContact(ctx, "alice", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "alice", "", "alice@example.com"); err != nil {
		t.Fatal(err)
	}

	seen := map[int64]int{}
	for offset := 0; offset < 6; offset += 2 {
		msgs, err := st.ContactMessages(ctx, "alice", store.ContactMessagesOpts{Limit: 2, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range msgs {
			seen[m.ID]++
		}
	}
	if len(seen) != 5 {
		t.Fatalf("paged over %d distinct messages, want 5", len(seen))
	}
	for id, n := range seen {
		if n != 1 {
			t.Errorf("message %d returned %d times across pages", id, n)
		}
	}
	if _, err := st.ContactMessages(ctx, "alice", store.ContactMessagesOpts{Offset: -1}); err == nil {
		t.Error("a negative offset should be a usage error")
	}
}
