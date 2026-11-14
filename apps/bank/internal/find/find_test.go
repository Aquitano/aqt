package find

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type archive struct{ texts search.List }

func (archive) SearchMessages(context.Context, search.Query, search.Filters, int) (search.List, error) {
	return search.List{Kind: search.KindMessage}, nil
}
func (a archive) SearchTexts(context.Context, search.Query, search.Filters, int) (search.List, error) {
	return a.texts, nil
}
func (archive) SearchAttachmentNames(context.Context, search.Query, search.Filters, int) (search.List, error) {
	return search.List{Kind: search.KindFile}, nil
}
func (archive) SearchLibrary(_ context.Context, _ store.LibraryList, _ search.Query, _ search.Filters, _ int) (search.List, error) {
	return search.List{}, nil
}
func (archive) ContentPlaces(_ context.Context, ids []int64) (map[int64]store.ContentPlaces, error) {
	out := map[int64]store.ContentPlaces{}
	for _, id := range ids {
		out[id] = store.ContentPlaces{Ref: "content:000000000000000" + string(rune('0'+id)), Count: 1,
			Places: []search.FilePlace{{Kind: "message", Ref: "msg:0123456789abcdef", Name: "lease.pdf"}}}
	}
	return out, nil
}
func (archive) ContactKeys(_ context.Context, name string) ([]string, error) {
	return []string{name}, nil
}

type lists struct {
	archive
	*disks
}

type disks struct {
	err   error
	calls int
	names search.List
}

func (d *disks) RankEntries(context.Context, search.Query, int) (search.List, error) {
	d.calls++
	return d.names, d.err
}
func (d *disks) RankMembers(context.Context, search.Query, int) (search.List, error) {
	return search.List{}, nil
}
func (d *disks) RankMetadata(context.Context, search.Query, int) (search.List, error) {
	return search.List{}, nil
}
func (d *disks) RankAnalyses(context.Context, search.Query, int) (search.List, error) {
	return search.List{}, nil
}
func (d *disks) DiskPlaces(_ context.Context, ids []int64, _ int) (map[int64][]search.FilePlace, map[int64]int, error) {
	places, counts := map[int64][]search.FilePlace{}, map[int64]int{}
	for _, id := range ids {
		places[id], counts[id] = []search.FilePlace{{Kind: "disk", EntryID: 9, Path: "/lease.pdf"}}, 1
	}
	return places, counts, nil
}

func TestFindRejectsConflictingFilters(t *testing.T) {
	for _, f := range []search.Filters{{From: "alice", Kind: "movie"}, {Account: "owner", From: "alice"}, {Account: "owner", Kind: "message"}} {
		if _, err := Find(t.Context(), lists{archive{}, &disks{}}, parse(t, "film"), f, 20, 0); !errors.Is(err, ErrFilters) {
			t.Errorf("filters %+v: %v, want ErrFilters", f, err)
		}
	}
}

func TestFindLeavesFilesOnDisksOutOfAScopedSearch(t *testing.T) {
	found := &disks{}
	if _, err := Find(t.Context(), lists{archive{}, found}, parse(t, "minecraft"), search.Filters{}, 20, 0); err != nil || found.calls != 1 {
		t.Fatalf("an unscoped search searched the disks %d times: %v", found.calls, err)
	}
	for name, f := range map[string]search.Filters{
		"sender": {From: "alice"}, "kind": {Kind: "movie"}, "source": {Source: "gmail"},
		"date": {Since: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	} {
		found := &disks{}
		result, err := Find(t.Context(), lists{archive{}, found}, parse(t, "minecraft"), f, 20, 0)
		if err != nil || found.calls != 0 {
			t.Errorf("%s-scoped search searched the disks %d times: %v", name, found.calls, err)
		}
		if name != "kind" && len(result.Coverage) == 0 {
			t.Errorf("%s-scoped search does not say what it left out", name)
		}
	}
	failure := errors.New("connection reset")
	if _, err := Find(t.Context(), lists{archive{}, &disks{err: failure}}, parse(t, "minecraft"), search.Filters{}, 20, 0); !errors.Is(err, failure) {
		t.Fatalf("a failing catalogue answered %v", err)
	}
}

// A content found by its text in the archive and by its name on a disk is
// one hit, ranked above a hit only one list found, with the places of both.
func TestFindFusesAContentAcrossLists(t *testing.T) {
	content := search.SearchHit{Kind: search.KindFile, Key: search.ContentKey(5), ContentID: 5}
	folder := search.SearchHit{Kind: search.KindFile, Key: "entry 3", Title: "lease", Type: "dir"}
	result, err := Find(t.Context(), lists{archive{texts: search.List{Name: "text", Kind: search.KindFile, Hits: []search.SearchHit{content}, Matches: 1}},
		&disks{names: search.List{Name: "disk name", Kind: search.KindFile, Hits: []search.SearchHit{folder, content}, Matches: 2}}},
		parse(t, "lease"), search.Filters{}, 20, 0)
	if err != nil || len(result.Hits) != 2 {
		t.Fatalf("hits %+v, %v", result.Hits, err)
	}
	hit := result.Hits[0]
	if hit.ContentID != 5 || hit.Ref != "content:0000000000000005" || hit.Title != "lease.pdf" || hit.PlaceCount != 2 ||
		!slices.Equal(hit.Matched, []string{"text", "disk name"}) {
		t.Fatalf("first hit %+v, want the content found by both lists with both places", hit)
	}
	if len(result.Counts) != 1 || result.Counts[0] != (search.KindCount{Kind: search.KindFile, Matches: 3}) {
		t.Fatalf("counts %+v", result.Counts)
	}
	if !strings.HasPrefix(result.Hits[1].Key, "entry") {
		t.Fatalf("second hit %+v, want the folder", result.Hits[1])
	}
}

func parse(t *testing.T, query string) search.Query {
	t.Helper()
	q, err := search.Parse(query, search.All)
	if err != nil {
		t.Fatal(err)
	}
	return q
}
