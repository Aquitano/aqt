package server

import (
	"context"
	"errors"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func importWatch(t *testing.T, s *Server) library.Activity {
	t.Helper()
	item := library.Item{Identity: library.Identity{Source: "youtube", Account: "thomas", ExternalID: "video:5C_HPTJg5ek"}, Kind: "video", Title: "Rust in 100 Seconds"}
	item.ID = library.StableID("item", item.Identity)
	activity := library.Activity{Identity: library.Identity{Source: "youtube", Account: "thomas", ExternalID: "watch:digest"}, ItemID: item.ID, Kind: "watch",
		Title: item.Title, Occurred: library.Date{Precision: "instant", Value: "2026-08-14T09:12:33Z"}}
	activity.ID = library.StableID("activity", activity.Identity)
	if _, err := s.db.ImportLibrary(context.Background(), library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{activity}}); err != nil {
		t.Fatal(err)
	}
	return activity
}

func TestLibraryGetFetchesOneActivity(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	activity := importWatch(t, s)

	got, err := c.LibraryActivity(ctx, activity.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != activity.ID || got.ItemID != activity.ItemID || got.Occurred != activity.Occurred {
		t.Fatalf("activity = %+v", got)
	}
	if _, err := c.LibraryActivity(ctx, "activity_missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing activity: %v", err)
	}
}
