package scan

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

// rewrittenDocument scans a document, rewrites it with other words and scans
// again, returning the entry and both scans.
func rewrittenDocument(t *testing.T) (st *store.Store, entry store.Hit, first, second Result) {
	t.Helper()
	st, _ = storetest.New(t)
	root := t.TempDir()
	write(t, root, "plans/server.txt", "minecraft lobby for the class of 2017")
	first = scanAt(t, st, root, testVolume)
	entry = find(t, st, "server")
	write(t, root, "plans/server.txt", "rewritten as a static website")
	second = scanAt(t, st, root, testVolume)
	return st, entry, first, second
}

func TestChangedDocumentKeepsItsEarlierTextSearchable(t *testing.T) {
	st, entry, _, _ := rewrittenDocument(t)
	ctx := context.Background()

	old, err := st.SearchTexts(ctx, store.SearchOptions{Query: "minecraft lobby"})
	if err != nil || len(old) != 1 || len(old[0].Places) != 1 {
		t.Fatalf("earlier text: %+v, %v; want one hit at one place", old, err)
	}
	if p := old[0].Places[0]; p.ID != entry.ID || p.Path != "/plans/server.txt" || p.Version != store.VersionPrevious || p.Ref != old[0].Ref {
		t.Errorf("earlier text place %+v, want entry %d flagged previous with the old ref %s", p, entry.ID, old[0].Ref)
	}
	now, err := st.SearchTexts(ctx, store.SearchOptions{Query: "static website"})
	if err != nil || len(now) != 1 || now[0].Places[0].Version != store.VersionCurrent {
		t.Errorf("current text: %+v, %v; want one hit flagged current", now, err)
	}
}

func TestCurrentSearchLeavesOutEarlierVersions(t *testing.T) {
	st, _, _, _ := rewrittenDocument(t)
	ctx := context.Background()

	if hits, err := st.SearchTexts(ctx, store.SearchOptions{Query: "minecraft lobby", Current: true}); err != nil || len(hits) != 0 {
		t.Errorf("--current found %+v, %v; want nothing", hits, err)
	}
	if hits, err := st.SearchTexts(ctx, store.SearchOptions{Query: "static website", Current: true}); err != nil || len(hits) != 1 {
		t.Errorf("--current missed the current text: %+v, %v", hits, err)
	}
}

func TestShowListsAnEntrysVersions(t *testing.T) {
	st, entry, first, second := rewrittenDocument(t)
	ctx := context.Background()

	d, err := st.Entry(ctx, entry.ID)
	if err != nil || len(d.Versions) != 2 {
		t.Fatalf("versions %+v, %v; want two", d.Versions, err)
	}
	now, before := d.Versions[0], d.Versions[1]
	if now.Version != store.VersionCurrent || now.Ref != d.Ref || now.FirstScan != second.ScanID || now.ReplacedScan != nil {
		t.Errorf("newest version %+v, want the current ref %s from scan %d", now, d.Ref, second.ScanID)
	}
	if before.Version != store.VersionPrevious || before.Ref != entry.Ref || before.FirstScan != first.ScanID ||
		before.ReplacedScan == nil || *before.ReplacedScan != second.ScanID || before.Size == now.Size {
		t.Errorf("earlier version %+v, want ref %s from scan %d replaced in scan %d", before, entry.Ref, first.ScanID, second.ScanID)
	}
	c, err := st.Content(ctx, entry.Ref)
	if err != nil || len(c.Occurrences) != 1 || c.Occurrences[0].ID != entry.ID || c.Occurrences[0].Version != store.VersionPrevious {
		t.Errorf("show of the earlier ref: %+v, %v; want the entry as a previous holder", c.Occurrences, err)
	}
}

// Moving, renaming and touching a file rehash nothing new: the entry keeps
// the one version it had.
func TestMovesAndTouchesKeepOneVersion(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a/notes.txt", "same bytes throughout")
	scanAt(t, st, root, testVolume)
	entry := find(t, st, "notes")
	if err := os.Rename(filepath.Join(root, "a"), filepath.Join(root, "b")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "b", "notes.txt"), filepath.Join(root, "b", "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	scanAt(t, st, root, testVolume)
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(root, "b", "renamed.txt"), later, later); err != nil {
		t.Fatal(err)
	}
	if res := scanAt(t, st, root, testVolume); res.Counts.Hashed != 1 {
		t.Fatalf("touch hashed %d files, want the touched one", res.Counts.Hashed)
	}

	d, err := st.Entry(context.Background(), entry.ID)
	if err != nil || d.Path != "/b/renamed.txt" || len(d.Versions) != 1 {
		t.Fatalf("entry %s with versions %+v, %v; want /b/renamed.txt with one", d.Path, d.Versions, err)
	}
	if v := d.Versions[0]; v.Version != store.VersionCurrent || v.Ref != entry.Ref || v.ReplacedScan != nil {
		t.Errorf("version %+v, want the original ref %s still current", v, entry.Ref)
	}
}
