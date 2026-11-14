package store

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/search"
)

// The catalogue's ranked lists for the archive's combined search. Each
// returns its best n hits by score, ties broken by the index's key, and how
// many match. A hit for bytes is keyed by their content, so the archive's
// lists and these fuse into one hit per file.

// RankEntries ranks files and folders on disks by name and path. A hashed
// file is its content; a folder or an unhashed file is the entry itself.
func (s *Store) RankEntries(ctx context.Context, q search.Query, n int) (search.List, error) {
	list := search.List{Name: "disk name", Kind: search.KindFile}
	var a []any
	next := func(v any) string { a = append(a, v); return "$" + strconv.Itoa(len(a)) }
	cond := "e.id @@@ " + q.Clause(nameFields, next)
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx, `select e.id, e.kind, e.name, e.path, e.content_id, e.modified_at,
			e.missing_scan is not null, coalesce(nullif(v.label, ''), v.id::text)
		from (select e.* from entries e where `+cond+` order by paradedb.score(e.id) desc, e.id limit `+strconv.Itoa(n)+`) e
		join volumes v on v.id = e.volume_id`,
		`select count(*) from entries e where `+cond, a,
		func(row pgx.CollectableRow) (search.SearchHit, error) {
			h := search.SearchHit{Kind: search.KindFile}
			var p search.FilePlace
			var content *int64
			var modified *time.Time
			err := row.Scan(&p.EntryID, &h.Type, &h.Title, &p.Path, &content, &modified, &p.Missing, &p.Volume)
			if content != nil {
				h.ContentID, h.Key, h.Type = *content, search.ContentKey(*content), ""
				return h, err
			}
			p.Kind, p.Name, p.At = "disk", h.Title, modified
			h.Key, h.Places, h.PlaceCount = "entry "+strconv.FormatInt(p.EntryID, 10), []search.FilePlace{p}, 1
			return h, err
		})
	return list, err
}

// RankMembers ranks files inside archives by name and path. A member is a
// hit for the archive that holds it, with the member's path as its snippet.
func (s *Store) RankMembers(ctx context.Context, q search.Query, n int) (search.List, error) {
	list := search.List{Name: "archive member", Kind: search.KindFile}
	var a []any
	next := func(v any) string { a = append(a, v); return "$" + strconv.Itoa(len(a)) }
	cond := "m.id @@@ " + q.Clause(nameFields, next)
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx, `select m.archive_id, m.path from members m where `+cond+`
		order by paradedb.score(m.id) desc, m.id limit `+strconv.Itoa(n),
		`select count(*) from members m where `+cond, a,
		func(row pgx.CollectableRow) (search.SearchHit, error) {
			h := search.SearchHit{Kind: search.KindFile}
			var path string
			err := row.Scan(&h.ContentID, &path)
			h.Key, h.Snippet = search.ContentKey(h.ContentID), "contains "+path
			return h, err
		})
	return list, err
}

// RankMetadata ranks contents by their embedded metadata, RankAnalyses by
// what OCR and image descriptions said about them.
func (s *Store) RankMetadata(ctx context.Context, q search.Query, n int) (search.List, error) {
	return s.rankText(ctx, q, n, "metadata", "metadata t", "t.content_id", "true")
}

func (s *Store) RankAnalyses(ctx context.Context, q search.Query, n int) (search.List, error) {
	return s.rankText(ctx, q, n, "analysis", "ai_results t", "t.id", "t.status in ('ok', 'truncated')")
}

// from and key are package-owned literals, never parameters.
func (s *Store) rankText(ctx context.Context, q search.Query, n int, name, from, key, filter string) (search.List, error) {
	list := search.List{Name: name, Kind: search.KindFile}
	var a []any
	next := func(v any) string { a = append(a, v); return "$" + strconv.Itoa(len(a)) }
	cond := key + " @@@ " + q.Clause(textFields, next) + " and " + filter
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx, `select t.content_id,
			coalesce(paradedb.snippet(t.text, start_tag => '', end_tag => '', max_num_chars => 200), '')
		from `+from+` where `+cond+` order by paradedb.score(`+key+`) desc, `+key+` limit `+strconv.Itoa(n),
		`select count(*) from `+from+` where `+cond, a,
		func(row pgx.CollectableRow) (search.SearchHit, error) {
			h := search.SearchHit{Kind: search.KindFile}
			err := row.Scan(&h.ContentID, &h.Snippet)
			h.Key = search.ContentKey(h.ContentID)
			return h, err
		})
	return list, err
}

// DiskPlaces lists the entries that hold each content now or held it before
// its bytes changed: present copies first, then missing ones, then earlier
// versions, at most max per content, with the count of all.
func (s *Store) DiskPlaces(ctx context.Context, ids []int64, max int) (map[int64][]search.FilePlace, map[int64]int, error) {
	places, counts := map[int64][]search.FilePlace{}, map[int64]int{}
	if len(ids) == 0 {
		return places, counts, nil
	}
	rows, err := s.pool.Query(ctx, `select content_id, id, name, path, label, modified_at, missing, previous, total from (
		select p.*, row_number() over (partition by content_id order by previous, missing, id) as position,
			count(*) over (partition by content_id) as total
		from (select distinct on (p.content_id, e.id) p.content_id, e.id, e.name, e.path,
				coalesce(nullif(v.label, ''), v.id::text) as label, e.modified_at,
				e.missing_scan is not null as missing, p.previous
			from (select content_id, id as entry_id, false as previous from entries where content_id = any($1)
				union all
				select content_id, entry_id, true from entry_versions where content_id = any($1) and replaced_scan is not null) p
			join entries e on e.id = p.entry_id join volumes v on v.id = e.volume_id
			order by p.content_id, e.id, p.previous) p
		) p where position <= $2 order by content_id, position`, ids, max)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var total int
		p := search.FilePlace{Kind: "disk"}
		if err := rows.Scan(&id, &p.EntryID, &p.Name, &p.Path, &p.Volume, &p.At, &p.Missing, &p.Previous, &total); err != nil {
			return nil, nil, err
		}
		places[id] = append(places[id], p)
		counts[id] = total
	}
	return places, counts, rows.Err()
}
