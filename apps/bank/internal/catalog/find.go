package catalog

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"golang.org/x/sync/errgroup"

	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var ErrFilters = errors.New("incompatible search filters")

// Archive is the archive's side of the combined search: its ranked lists, the
// places that hold a content, and a contact's identities.
type Archive interface {
	SearchMessages(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error)
	SearchTexts(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error)
	SearchAttachmentNames(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error)
	SearchLibrary(ctx context.Context, l store.LibraryList, q search.Query, f search.Filters, n int) (search.List, error)
	ContentPlaces(ctx context.Context, ids []int64) (map[int64]store.ContentPlaces, error)
	ContactKeys(ctx context.Context, name string) ([]string, error)
}

// Disks is the catalogue of files on disks: its ranked lists and the entries
// that hold a content.
type Disks interface {
	RankEntries(ctx context.Context, q search.Query, n int) (search.List, error)
	RankMembers(ctx context.Context, q search.Query, n int) (search.List, error)
	RankMetadata(ctx context.Context, q search.Query, n int) (search.List, error)
	RankAnalyses(ctx context.Context, q search.Query, n int) (search.List, error)
	DiskPlaces(ctx context.Context, ids []int64, max int) (map[int64][]search.FilePlace, map[int64]int, error)
}

type Result struct {
	Hits     []search.SearchHit `json:"hits" doc:"Best first. A page shorter than limit is the end of the list."`
	Counts   []search.KindCount `json:"counts" doc:"How many records of each kind searched match, so a caller sees what lies past this page or behind a kind filter."`
	Coverage []string           `json:"coverage" doc:"What the result leaves out or does not prove, such as kinds a filter skipped."`
}

const maxPlaces = 20

// Find searches every kind of record at once. Each ranked list returns its
// best offset+limit hits, the lists run concurrently, and reciprocal rank
// fusion orders their union: a record found by several lists, such as a PDF
// whose name and text both match, is one hit. A search makes one round trip
// per list, each with a page and a count, and three statements to list the
// places of the files on the page.
func Find(ctx context.Context, archive Archive, disks Disks, query string, mode search.Mode, f search.Filters, limit, offset int) (Result, error) {
	result := Result{Hits: []search.SearchHit{}, Counts: []search.KindCount{}, Coverage: []string{}}
	limit = page.Limit(limit)
	if err := page.Check(limit, offset); err != nil {
		return result, err
	}
	if err := f.Validate(); err != nil {
		return result, err
	}
	q, err := search.Parse(query, mode)
	if err != nil {
		return result, err
	}
	if f.MessageScoped() && !f.Wants(search.KindMessage) && !f.Wants(search.KindFile) {
		return result, fmt.Errorf("message filters cannot be combined with kind %s: %w", f.Kind, ErrFilters)
	}
	if f.Account != "" && (f.MessageScoped() || f.Kind == search.KindMessage) {
		return result, fmt.Errorf("account cannot be combined with message filters: %w", ErrFilters)
	}
	if f.Person != "" {
		if f.Participants, err = archive.ContactKeys(ctx, f.Person); err != nil {
			return result, err
		}
	}

	n := offset + limit
	type run func(context.Context) (search.List, error)
	var runs []run
	archiveList := func(rank func(context.Context, search.Query, search.Filters, int) (search.List, error)) run {
		return func(ctx context.Context) (search.List, error) { return rank(ctx, q, f, n) }
	}
	diskList := func(rank func(context.Context, search.Query, int) (search.List, error)) run {
		return func(ctx context.Context) (search.List, error) { return rank(ctx, q, n) }
	}
	files := f.Wants(search.KindFile)
	if f.Wants(search.KindMessage) && f.Account == "" {
		runs = append(runs, archiveList(archive.SearchMessages))
	}
	if files {
		runs = append(runs, archiveList(archive.SearchTexts))
		if f.Account == "" {
			runs = append(runs, archiveList(archive.SearchAttachmentNames))
		}
	}
	for _, l := range []store.LibraryList{store.ItemList, store.ActivityList, store.CollectionList, store.PageList, store.LibraryFileList} {
		runs = append(runs, func(ctx context.Context) (search.List, error) { return archive.SearchLibrary(ctx, l, q, f, n) })
	}
	onDisks := files && f.Source == "" && f.Account == "" && !f.Dated() && !f.MessageScoped()
	if onDisks {
		runs = append(runs, diskList(disks.RankEntries), diskList(disks.RankMembers), diskList(disks.RankMetadata), diskList(disks.RankAnalyses))
	}

	lists := make([]search.List, len(runs))
	group, groupCtx := errgroup.WithContext(ctx)
	for i, r := range runs {
		group.Go(func() (err error) {
			lists[i], err = r(groupCtx)
			return err
		})
	}
	if err := group.Wait(); err != nil {
		return result, err
	}

	result.Hits = search.Fuse(lists, offset, limit)
	if err := placeFiles(ctx, archive, disks, onDisks, result.Hits); err != nil {
		return result, err
	}
	result.Counts = counts(lists)
	result.Coverage = coverage(f, lists)
	return result, nil
}

// placeFiles gives each file hit its ref, its places and, when no list named
// it, the name of its first place.
func placeFiles(ctx context.Context, archive Archive, disks Disks, onDisks bool, hits []search.SearchHit) error {
	var ids []int64
	for _, h := range hits {
		if h.ContentID != 0 {
			ids = append(ids, h.ContentID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	held, err := archive.ContentPlaces(ctx, ids)
	if err != nil {
		return err
	}
	var diskPlaces map[int64][]search.FilePlace
	var diskCounts map[int64]int
	if onDisks {
		if diskPlaces, diskCounts, err = disks.DiskPlaces(ctx, ids, maxPlaces); err != nil {
			return err
		}
	}
	for i := range hits {
		h := &hits[i]
		if h.ContentID == 0 {
			continue
		}
		c := held[h.ContentID]
		h.Ref, h.Digest = c.Ref, c.Digest
		h.Places = slices.Concat(c.Places, diskPlaces[h.ContentID])
		h.PlaceCount = c.Count + diskCounts[h.ContentID]
		if len(h.Places) > maxPlaces {
			h.Places = h.Places[:maxPlaces]
		}
		if h.Title == "" && len(h.Places) > 0 {
			h.Title = h.Places[0].Name
		}
	}
	return nil
}

func counts(lists []search.List) []search.KindCount {
	out := []search.KindCount{}
	for _, kind := range search.HitKinds {
		i := slices.IndexFunc(out, func(c search.KindCount) bool { return c.Kind == kind })
		for _, l := range lists {
			if l.Kind != kind || l.Matches == 0 {
				continue
			}
			if i < 0 {
				out, i = append(out, search.KindCount{Kind: kind}), len(out)
			}
			out[i].Matches += l.Matches
		}
	}
	return out
}

func coverage(f search.Filters, lists []search.List) []string {
	var out []string
	switch {
	case f.MessageScoped():
		out = append(out, "Message filters restrict this search to messages and the files attached to them.")
	case f.Account != "":
		out = append(out, "Account filters apply to the library. Messages, their attachments and files on disks are left out.")
	case f.Dated():
		out = append(out, "Date filters apply to messages, activity and files attached to messages sent then. Items, collections, pages, library files and files on disks have no date and are left out.")
	case f.Source != "" && f.Wants(search.KindFile):
		out = append(out, "Files on disks belong to no source and are left out.")
	}
	if slices.ContainsFunc(lists, func(l search.List) bool { return l.Kind == search.KindActivity && l.Matches > 0 }) {
		out = append(out, "Only imported activity is searched: an absent activity is not evidence that something was not watched.")
	}
	return append([]string{}, out...)
}
