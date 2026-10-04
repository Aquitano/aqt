package store_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestLibraryHistoryReplayRetainsPrecisionEvidenceAndConflicts(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("precision")
	item.ExternalID = "video:" + item.ProviderID
	item.ID = library.StableID("item", item.Identity)
	event := library.Activity{Identity: library.Identity{Source: "youtube", Account: "owner", ExternalID: strings.Repeat("a", 64)}, ItemID: item.ID, Kind: "watch", Occurred: library.Date{Precision: "instant", Value: "2026-10-02T12:00:33Z"}, Provenance: library.Provenance{RawRef: "youtube/history.html", Locator: "row 1"}}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: []library.Activity{event}}); err != nil {
		t.Fatal(err)
	}
	event.Occurred.Value = "2026-10-02T12:00:33.123Z"
	event.Provenance = library.Provenance{RawRef: "youtube/history.json", Locator: "row 1"}
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
	root := t.TempDir()
	opts := mediaimport.Options{Source: "yt-private", Account: "owner"}
	inputs := []struct{ name, body string }{
		{"watch-history.html", `<html><body><div class="outer-cell"><div class="content-cell mdl-typography--body-1">Watched <a href="https://www.youtube.com/watch?v=abcdefghijk">A careful voyage</a><br>Oct 2, 2026, 12:00:33 PM UTC</div></div></body></html>`},
		{"watch-history.json", `[{"header":"YouTube","title":"Watched A careful voyage","titleUrl":"https://www.youtube.com/watch?v=abcdefghijk","time":"2026-10-02T12:00:33.123Z"},{"header":"YouTube","title":"Watched New voyage","titleUrl":"https://www.youtube.com/watch?v=lmnopqrstuv","time":"2026-10-02T12:01:00Z"}]`},
	}
	var history mediaimport.Parsed
	for i, input := range inputs {
		path := filepath.Join(root, input.name)
		if err := os.WriteFile(path, []byte(input.body), 0600); err != nil {
			t.Fatal(err)
		}
		parsed, err := mediaimport.Parse("youtube-media", path, opts)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			history = parsed
		} else if parsed.Batch.Activity[0].ID != history.Batch.Activity[0].ID {
			t.Fatal("HTML and JSON history identities differ")
		}
		result, err := st.ImportLibrary(ctx, parsed.Batch)
		if err != nil || result.Activity != 1 || (i == 1 && result.Duplicates != 2) {
			t.Fatalf("custom-source %s import: %+v %v", input.name, result, err)
		}
	}
	events, err := st.ListLibraryActivity(ctx, library.ListOptions{Source: opts.Source})
	if err != nil || len(events) != 2 || events[1].Occurred.Value != "2026-10-02T12:00:33.123Z" || len(events[1].Evidence) != 2 {
		t.Fatalf("custom-source precision or evidence lost: %+v %v", events, err)
	}
	for _, test := range []string{"non-history ID", "non-YouTube item"} {
		item := history.Batch.Items[0]
		event := history.Batch.Activity[0]
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

func TestNetflixLegacyAliasesPreserveMultiplicityRowsAndEvidence(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("netflix-title")
	item.Source = "netflix"
	item.ID = library.StableID("item", item.Identity)
	item.Title = "Film"
	date := library.Date{Precision: "day", Value: "2026-10-02"}
	legacy := []library.Activity{}
	for _, export := range []string{"a", "b"} {
		for _, row := range []int{2, 10} {
			legacy = append(legacy, library.Activity{Identity: library.Identity{Source: "netflix", Account: "owner", ExternalID: fmt.Sprintf("file:%s:row:%d", strings.Repeat(export, 64), row)}, ItemID: item.ID, Kind: "watch", Title: item.Title, Occurred: date, Provenance: library.Provenance{RawRef: "netflix/" + export + ".csv", Locator: fmt.Sprintf("row %d", row)}})
		}
	}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}, Activity: legacy}); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(item.Title + "\x00" + date.Precision + "\x00" + date.Value))
	stable := []library.Activity{}
	for occurrence := 1; occurrence <= 3; occurrence++ {
		stable = append(stable, library.Activity{Identity: library.Identity{Source: "netflix", Account: "owner", ExternalID: fmt.Sprintf("viewing:%s:occurrence:%d", hex.EncodeToString(sum[:]), occurrence)}, ItemID: item.ID, Kind: "watch", Title: item.Title, Occurred: date, Provenance: library.Provenance{RawRef: "netflix/new.csv", Locator: fmt.Sprintf("row %d", occurrence+1)}})
	}
	result, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: stable})
	if err != nil || result.Activity != 1 || result.Duplicates != 2 {
		t.Fatalf("alias replay: %+v %v", result, err)
	}
	result, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: stable})
	if err != nil || result.Activity != 0 || result.Duplicates != 3 {
		t.Fatalf("stable replay: %+v %v", result, err)
	}
	events, err := st.ListLibraryActivity(ctx, library.ListOptions{ItemID: item.ID})
	if err != nil || len(events) != 5 {
		t.Fatalf("legacy observations collapsed or duplicated: %+v %v", events, err)
	}
	for _, old := range legacy {
		found := false
		for _, event := range events {
			if event.ID == library.StableID("activity", old.Identity) {
				found = true
				if event.Provenance != old.Provenance || len(event.Evidence) == 0 {
					t.Fatalf("legacy provenance lost: %+v", event)
				}
				if strings.HasPrefix(old.ExternalID, "file:"+strings.Repeat("a", 64)) && (len(event.Evidence) != 2 || event.Evidence[1].Locator != fmt.Sprintf("row %d", map[string]int{"row 2": 2, "row 10": 3}[old.Provenance.Locator])) {
					t.Fatalf("CSV numeric occurrence or replay evidence lost: %+v", event)
				}
			}
		}
		if !found {
			t.Fatalf("legacy ID lost: %s", old.ExternalID)
		}
	}
	stable[0].Account = "another"
	if result, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: stable[:1]}); err != nil || result.Activity != 1 {
		t.Fatalf("account observations conflated: %+v %v", result, err)
	}
}

func TestNetflixLegacyAliasesMatchExactDateRepresentation(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	item := libraryItem("netflix-date")
	item.Source = "netflix"
	item.ID = library.StableID("item", item.Identity)
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	for i, date := range []library.Date{{Precision: "unknown"}, {Precision: "day", Value: "2026-10-02"}, {Precision: "instant", Value: "2026-10-02T12:00:00.123+02:00"}} {
		legacy := library.Activity{Identity: library.Identity{Source: "netflix", Account: "owner", ExternalID: fmt.Sprintf("file:%064x:row:2", i)}, ItemID: item.ID, Kind: "watch", Title: item.Title, Occurred: date}
		if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{legacy}}); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(item.Title + "\x00" + date.Precision + "\x00" + date.Value))
		stable := legacy
		stable.ExternalID = "viewing:" + hex.EncodeToString(sum[:]) + ":occurrence:1"
		result, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{stable}})
		if err != nil || result.Activity != 0 || result.Duplicates != 1 {
			t.Fatalf("%+v alias failed: %+v %v", date, result, err)
		}
	}
	date := library.Date{Precision: "day", Value: "2026-10-03"}
	sum := sha256.Sum256([]byte(item.Title + "\x00" + date.Precision + "\x00" + date.Value))
	next := library.Activity{Identity: library.Identity{Source: "netflix", Account: "owner", ExternalID: "viewing:" + hex.EncodeToString(sum[:]) + ":occurrence:1"}, ItemID: item.ID, Kind: "watch", Title: item.Title, Occurred: date}
	result, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Activity: []library.Activity{next}})
	if err != nil || result.Activity != 1 {
		t.Fatalf("different days conflated: %+v %v", result, err)
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
		sum := fmt.Sprintf("%064x", i)
		if err = st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "invoice.pdf", SHA256: sum}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "invoice", Limit: 200})
	if err != nil || len(page) != 200 {
		t.Fatalf("requested limit changed: %d %v", len(page), err)
	}
	next, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "invoice", Limit: 200, Offset: 200})
	if err != nil || len(next) != 5 || page[199].SHA256 == next[0].SHA256 {
		t.Fatalf("continuation skipped matches: %+v %v", next, err)
	}
	sum := fmt.Sprintf("%064x", 204)
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "quasar orbit", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		mode, query string
		count       int
	}{
		{"any", "invoice quasar", 205},
		{"all", "invoice quasar", 1},
		{"phrase", "pdf quasar", 1},
		{"phrase", "quasar orbit", 1},
		{"phrase", "orbit quasar", 0},
	} {
		rows, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: test.query, Match: test.mode, Limit: 500})
		if err != nil || len(rows) != test.count {
			t.Fatalf("%s %q: %d matches, want %d: %v", test.mode, test.query, len(rows), test.count, err)
		}
	}
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "nebula", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "quasar"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("search index retained replaced text: %+v %v", rows, err)
	}
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "nebula", Status: "failed"}); err != nil {
		t.Fatal(err)
	}
	rows, err = st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "nebula"})
	if err != nil || len(rows) != 0 {
		t.Fatalf("invalid extraction became searchable: %+v %v", rows, err)
	}
}
