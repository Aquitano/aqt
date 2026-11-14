package search

import (
	"cmp"
	"slices"
	"strconv"
	"time"
)

// Kinds a hit can be. A library hit's Type says which kind of item, activity
// or collection it is.
const (
	KindMessage    = "message"
	KindFile       = "file"
	KindItem       = "item"
	KindActivity   = "activity"
	KindCollection = "collection"
	KindPage       = "page"
)

// SearchHit is one record a search found: enough to list it and to open it, never
// a whole body. A file is its content, wherever it is: an attachment, a
// library file and a copy on a disk with the same bytes are one hit with three
// places.
type SearchHit struct {
	Kind string `json:"kind" enum:"message,file,item,activity,collection,page"`
	// Ref is what bank show and the record routes take. A folder, or a file a
	// scan has not hashed yet, has none; its place names the entry.
	Ref string `json:"ref,omitempty"`
	// Digest is a file's whole BLAKE3 digest, which /v1/blobs/{blake3}
	// serves when the archive holds the bytes.
	Digest  string `json:"blake3,omitempty"`
	Type    string `json:"type,omitempty" doc:"A library record's kind, such as movie or watch, or a disk entry's: dir or link."`
	Title   string `json:"title"`
	Snippet string `json:"snippet,omitempty" doc:"Text around the match, without markup."`
	// At is when a message was sent or an activity happened. A day without a
	// time is its UTC midnight with DayOnly set.
	At       *time.Time  `json:"at,omitempty"`
	DayOnly  bool        `json:"day_only,omitempty"`
	Source   string      `json:"source,omitempty"`
	ThreadID string      `json:"thread_id,omitempty" doc:"A message's thread, for opening its conversation with the thread route."`
	Places   []FilePlace `json:"places,omitempty" doc:"Where a file's bytes are, at most 20."`
	// PlaceCount counts every place, also those past the first 20.
	PlaceCount int     `json:"place_count,omitempty"`
	Score      float64 `json:"score" doc:"Reciprocal rank fusion: the sum of 1/(60+rank) over the ranked lists the hit is in."`
	// Matched names those lists.
	Matched []string `json:"matched"`

	// Key makes two hits the same record across lists: the content for a
	// file, otherwise the ref, and the entry for a disk entry without one.
	Key       string `json:"-"`
	ContentID int64  `json:"-"`
}

// FilePlace is one place a file's bytes are.
type FilePlace struct {
	Kind string `json:"kind" enum:"message,library_file,disk"`
	// Ref is the message's or library file's ref.
	Ref      string     `json:"ref,omitempty"`
	Name     string     `json:"name"`
	At       *time.Time `json:"at,omitempty"`
	Source   string     `json:"source,omitempty"`
	ThreadID string     `json:"thread_id,omitempty"`
	// EntryID, Volume and Path say where on which disk, for bank disk entry
	// and bank disk get.
	EntryID  int64  `json:"entry_id,omitempty"`
	Volume   string `json:"volume,omitempty"`
	Path     string `json:"path,omitempty"`
	Missing  bool   `json:"missing,omitempty"`
	Previous bool   `json:"previous,omitempty" doc:"The entry held these bytes before they changed."`
}

// List is one ranked list: one index's best matches for one kind, best first,
// and how many records match in all.
type List struct {
	Name    string
	Kind    string
	Hits    []SearchHit
	Matches int64
}

// KindCount is how many records of a kind match, before paging. A file matching
// in several lists, by name and by text for one, counts once per list.
type KindCount struct {
	Kind    string `json:"kind"`
	Matches int64  `json:"matches"`
}

// ContentKey is a file hit's key, the same whichever list found it.
func ContentKey(id int64) string { return "content " + strconv.FormatInt(id, 10) }

const rrfK = 60

// Fuse merges ranked lists by reciprocal rank fusion and returns the page
// [offset, offset+limit). A list must hold its best offset+limit hits for the
// page to be exact. Equal fused scores are ordered by the best rank a hit
// reached, then by kind and key, so a page means the same thing twice.
func Fuse(lists []List, offset, limit int) []SearchHit {
	type fused struct {
		hit  SearchHit
		best int
	}
	byKey := map[string]*fused{}
	var order []*fused
	for _, list := range lists {
		seen := map[string]bool{}
		rank := 0
		for _, h := range list.Hits {
			if seen[h.Key] {
				continue
			}
			seen[h.Key] = true
			rank++
			f, ok := byKey[h.Key]
			if !ok {
				h.Matched = nil
				f = &fused{hit: h, best: rank}
				byKey[h.Key] = f
				order = append(order, f)
			} else {
				merge(&f.hit, h)
				f.best = min(f.best, rank)
			}
			f.hit.Score += 1 / float64(rrfK+rank)
			f.hit.Matched = append(f.hit.Matched, list.Name)
		}
	}
	slices.SortStableFunc(order, func(a, b *fused) int {
		return cmp.Or(cmp.Compare(b.hit.Score, a.hit.Score), cmp.Compare(a.best, b.best),
			cmp.Compare(a.hit.Kind, b.hit.Kind), cmp.Compare(a.hit.Key, b.hit.Key))
	})
	out := []SearchHit{}
	for i := offset; i < len(order) && i < offset+limit; i++ {
		out = append(out, order[i].hit)
	}
	return out
}

// merge fills what the first list that found a hit left empty.
func merge(into *SearchHit, from SearchHit) {
	into.Ref = cmp.Or(into.Ref, from.Ref)
	into.Title = cmp.Or(into.Title, from.Title)
	into.Snippet = cmp.Or(into.Snippet, from.Snippet)
	into.Type = cmp.Or(into.Type, from.Type)
	if into.At == nil {
		into.At, into.DayOnly = from.At, from.DayOnly
	}
	into.Places = append(into.Places, from.Places...)
}
