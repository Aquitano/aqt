package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

var youtubeKind = importer.Register(mediaimport.YouTube{}, "YouTube Takeout")

func TestLibraryHistoryReplayRetainsPrecisionEvidenceAndConflicts(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("precision")
	item.ExternalID = "video:" + item.ProviderID
	item.ID = library.StableID("item", item.Identity)
	event := library.Activity{Identity: library.Identity{Source: "youtube", Account: "owner", ExternalID: strings.Repeat("a", 64)}, ItemID: item.ID, Kind: "watch", Occurred: library.Date{Precision: "instant", Value: "2026-10-02T12:00:33Z"}, Provenance: library.Provenance{RawInput: rawInput(t, st, "youtube/history.html"), Locator: "row 1"}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	event.Occurred.Value = "2026-10-02T12:00:33.123Z"
	event.Provenance = library.Provenance{RawInput: rawInput(t, st, "youtube/history.json"), Locator: "row 1"}
	fresh := event
	fresh.ExternalID = strings.Repeat("b", 64)
	fresh.Occurred.Value = "2026-10-02T12:01:33.456Z"
	result, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{event, fresh}})
	if err != nil || result.Activity != 1 || result.Duplicates != 1 {
		t.Fatalf("precision replay: %+v %v", result, err)
	}
	event.Occurred.Value = "2026-10-02T12:00:33Z"
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	events, err := st.ListLibraryActivity(ctx, library.ListOptions{ItemID: item.ID})
	if err != nil || len(events) != 2 || events[1].Occurred.Value != "2026-10-02T12:00:33.123Z" || len(events[1].Evidence) != 2 {
		t.Fatalf("lost precise timestamp or evidence: %+v %v", events, err)
	}
	duration := 12
	conflicts := []library.Activity{event, event, event, event}
	conflicts[0].Occurred.Value = "2026-10-02T12:00:33.124Z"
	conflicts[1].Occurred.Value = "2026-10-02T12:00:34Z"
	conflicts[2].Kind = "listen"
	conflicts[3].DurationSeconds = &duration
	for _, conflict := range conflicts {
		rollback := libraryItem("precision-rollback")
		if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{rollback}, Activity: []library.Activity{conflict}}); !errors.Is(err, library.ErrConflict) {
			t.Fatalf("immutable conflict accepted: %+v %v", conflict, err)
		}
		if _, err = st.LibraryItem(ctx, rollback.ID); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("conflict did not roll back batch: %v", err)
		}
	}
	item.Source = "custom-youtube"
	item.ID = library.StableID("item", item.Identity)
	event.Source = item.Source
	event.ItemID = item.ID
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	event.Occurred.Value = "2026-10-02T12:00:33.123Z"
	if result, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{event}}); err != nil || result.Duplicates != 1 {
		t.Fatalf("custom YouTube source precision replay: %+v %v", result, err)
	}
}

func TestYouTubeImporterCustomSourceReconcilesOnlyHistoryPrecision(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := importtest.On(t, st, youtubeKind)
	root := t.TempDir()
	opts := mediaimport.YouTubeOptions{Source: "yt-private", Account: "owner"}
	inputs := []struct{ name, body string }{
		{"watch-history.html", `<html><body><div class="outer-cell"><div class="content-cell mdl-typography--body-1">Watched <a href="https://www.youtube.com/watch?v=abcdefghijk">A careful voyage</a><br>Oct 2, 2026, 12:00:33 PM UTC</div></div></body></html>`},
		{"watch-history.json", `[{"header":"YouTube","title":"Watched A careful voyage","titleUrl":"https://www.youtube.com/watch?v=abcdefghijk","time":"2026-10-02T12:00:33.123Z"},{"header":"YouTube","title":"Watched New voyage","titleUrl":"https://www.youtube.com/watch?v=lmnopqrstuv","time":"2026-10-02T12:01:00Z"}]`},
	}
	for i, input := range inputs {
		path := filepath.Join(root, input.name)
		if err := os.WriteFile(path, []byte(input.body), 0600); err != nil {
			t.Fatal(err)
		}
		raw := importtest.MustImport(t, target, youtubeKind.Name, path, opts)
		if result := raw.Report.Library; result.Activity != 1 || (i == 1 && result.Duplicates != 2) {
			t.Fatalf("custom-source %s import: %+v", input.name, result)
		}
	}
	events, err := st.ListLibraryActivity(ctx, library.ListOptions{Source: opts.Source})
	if err != nil || len(events) != 2 || events[1].Occurred.Value != "2026-10-02T12:00:33.123Z" || len(events[1].Evidence) != 2 {
		t.Fatalf("custom-source precision or evidence lost: %+v %v", events, err)
	}
	historyEvent := events[1]
	historyEvent.Occurred.Value = "2026-10-02T12:00:33Z"
	historyItem, err := st.LibraryItem(ctx, historyEvent.ItemID)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []string{"non-history ID", "non-YouTube item"} {
		item := historyItem
		event := historyEvent
		if test == "non-history ID" {
			event.ExternalID = "manual-watch"
		} else {
			item.ExternalID = "manual-book"
			item.Kind = "book"
			item.Provider, item.ProviderID = "", ""
			item.ID = library.StableID("item", item.Identity)
			event.ExternalID = strings.Repeat("c", 64)
			event.ItemID = item.ID
		}
		event.ID = library.StableID("activity", event.Identity)
		if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
			t.Fatal(err)
		}
		event.Occurred.Value = "2026-10-02T12:00:33.123Z"
		if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{event}}); !errors.Is(err, library.ErrConflict) {
			t.Fatalf("%s allowed an immutable date change: %v", test, err)
		}
	}
}

func TestAttachmentSearchPreservesPagesAndCombinedTextModes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	id, err := st.InsertMessage(ctx, store.Message{Source: "mail", ExternalID: "attachment-pages", SentAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 205 {
		sum := content.Sum(fmt.Appendf(nil, "%d", i))
		if err = st.InsertAttachment(ctx, store.Attachment{MessageID: id, Position: i, Filename: "invoice.pdf", BLAKE3: sum}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "invoice", Limit: 200})
	if err != nil || len(page) != 200 {
		t.Fatalf("requested limit changed: %d %v", len(page), err)
	}
	next, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "invoice", Limit: 200, Offset: 200})
	if err != nil || len(next) != 5 || page[199].BLAKE3 == next[0].BLAKE3 {
		t.Fatalf("continuation skipped matches: %+v %v", next, err)
	}
	sum := content.Sum([]byte("204"))
	if err = st.PutBlobText(ctx, store.BlobText{BLAKE3: sum, Text: "quasar orbit", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		mode, query string
		count       int
	}{
		{"any", "invoice quasar", 205},
		// Every word must be in the filename or every word in the text.
		{"all", "invoice quasar", 0},
		{"all", "orbit quasar", 1},
		{"all", `"pdf quasar"`, 0},
		{"all", `"quasar orbit"`, 1},
		{"all", `"orbit quasar"`, 0},
	} {
		rows, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: test.query, Match: test.mode, Limit: 500})
		if err != nil || len(rows) != test.count {
			t.Fatalf("%s %q: %d matches, want %d: %v", test.mode, test.query, len(rows), test.count, err)
		}
	}
	if err = st.PutBlobText(ctx, store.BlobText{BLAKE3: sum, Text: "nebula", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "quasar"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("search index retained replaced text: %+v %v", rows, err)
	}
	if err = st.DeleteBlobText(ctx, sum); err != nil {
		t.Fatal(err)
	}
	if err = st.PutBlobText(ctx, store.BlobText{BLAKE3: sum, Text: "nebula", Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	rows, err = st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "nebula"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("invalid extraction became searchable: %+v %v", rows, err)
	}
}
