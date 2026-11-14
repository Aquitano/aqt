package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/jackc/pgx/v5"
)

const librarySnapshotBase = `(to_jsonb(s)-'collection_id'-'captured_at'-'captured_precision') || jsonb_build_object('captured',bank_library_date(s.captured_at,s.captured_precision))`
const librarySnapshotJSON = librarySnapshotBase + ` || jsonb_build_object('entries',coalesce((select jsonb_agg((to_jsonb(e)-'snapshot_id'-'added_at'-'added_precision') || jsonb_build_object('added',bank_library_date(e.added_at,e.added_precision)) order by e.position) from library_entries e where e.snapshot_id=s.id),'[]'::jsonb))`
const librarySnapshotSummaryJSON = librarySnapshotBase + ` || jsonb_build_object('entry_count',(select count(*) from library_entries e where e.snapshot_id=s.id))`
const librarySnapshotOrder = `s.captured_at desc nulls last,s.id desc`
const libraryCurrentSnapshot = `s.collection_id=r.id and (not r.personal or s.id=(select e.snapshot_id from library_collection_edits e where e.collection_id=r.id and e.revision=r.revision))`
const libraryItemJSON = `(to_jsonb(r)-'seq'-'state_notes'-'state_tags') || jsonb_build_object('evidence',coalesce((select jsonb_agg(jsonb_build_object('raw_input',e.raw_input_id,'locator',e.locator) order by e.raw_input_id,e.locator) from library_item_evidence e where e.item_id=r.id),'[]'::jsonb),'state',coalesce((select to_jsonb(st)-'item_id' from library_state st where st.item_id=r.id),'{"revision":0,"status":"","favorite":false,"progress":0,"progress_unit":"","notes":"","tags":[]}'::jsonb),'file_ids',coalesce((select jsonb_agg(f.file_id order by f.file_id) from library_item_files f where f.item_id=r.id),'[]'::jsonb))`
const libraryCollectionJSON = `(to_jsonb(r)-'seq') || jsonb_build_object('snapshot',(select ` + librarySnapshotJSON + ` from library_snapshots s where ` + libraryCurrentSnapshot + ` order by ` + librarySnapshotOrder + ` limit 1))`
const libraryCollectionSummaryJSON = `(to_jsonb(r)-'seq') || jsonb_build_object('snapshot',(select ` + librarySnapshotSummaryJSON + ` from library_snapshots s where ` + libraryCurrentSnapshot + ` order by ` + librarySnapshotOrder + ` limit 1))`
const libraryActivityJSON = `(to_jsonb(r)-'seq'-'occurred_at'-'occurred_precision') || jsonb_build_object('occurred',bank_library_date(r.occurred_at,r.occurred_precision),'evidence',coalesce((select jsonb_agg(jsonb_build_object('raw_input',e.raw_input_id,'locator',e.locator) order by e.raw_input_id,e.locator) from library_activity_evidence e where e.activity_id=r.id),'[]'::jsonb))`
const libraryFileJSON = `(to_jsonb(r)-'seq'-'ingested_at'-'content_id') || (select jsonb_build_object('blake3',encode(c.blake3,'hex'),'size_bytes',c.size_bytes) from contents c where c.id=r.content_id) || jsonb_build_object('item_ids',coalesce((select jsonb_agg(f.item_id order by f.item_id) from library_item_files f where f.file_id=r.id),'[]'::jsonb),'text_status',coalesce((select status from texts t where t.content_id=r.content_id),'pending'))`

func libraryProjection(table string) string {
	switch table {
	case "library_items":
		return libraryItemJSON
	case "library_collections":
		return libraryCollectionJSON
	case "library_activity":
		return libraryActivityJSON
	case "library_files":
		return libraryFileJSON
	default:
		return "to_jsonb(r)-'seq'"
	}
}

// ParseBoundary reads a date filter: a day, which starts at its midnight in
// UTC, or an RFC 3339 instant.
func ParseBoundary(v string) (time.Time, error) {
	if at, err := time.Parse("2006-01-02", v); err == nil {
		return at, nil
	}
	at, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("date filter must be YYYY-MM-DD or RFC3339")
	}
	return at.UTC(), nil
}

func listLibrary[T any](ctx context.Context, s *Store, table string, o library.ListOptions, projections ...string) ([]T, error) {
	out := []T{}
	if err := o.Validate(); err != nil {
		return out, err
	}
	o.Limit = page.Limit(o.Limit)
	f, err := libraryFilters(o)
	if err != nil {
		return out, err
	}
	var a args
	clauses := []string{"true"}
	if o.Source != "" {
		clauses = append(clauses, "r.source="+a.next(o.Source))
	}
	if o.Account != "" {
		clauses = append(clauses, "r.account="+a.next(o.Account))
	}
	if kind := f.Subkind(); kind != "" && table != "library_files" && table != "library_pages" {
		clauses = append(clauses, "r.kind="+a.next(kind))
	}
	if o.ItemID != "" {
		clauses = append(clauses, libraryItemFilter(table, a.next(o.ItemID)))
	}
	if table == "library_activity" {
		clauses = append(clauses, "true"+occurredBetween("r", f.Since, f.Until, &a))
	}
	order := "r.id"
	switch table {
	case "library_items", "library_collections", "library_pages":
		order = "lower(r.title),r.id"
	case "library_files":
		order = "lower(r.filename),r.id"
	case "library_activity":
		order = "r.occurred_at desc nulls last,r.id"
	}
	var window string
	if o.Query == "" {
		window = " limit " + a.next(o.Limit) + " offset " + a.next(o.Offset)
	} else {
		ranked, err := s.rankLibrary(ctx, table, o, f)
		if err != nil {
			return out, err
		}
		column := "r.id"
		if table == "library_files" {
			column = "r.content_id"
		}
		position := "array_position(" + a.next(ranked) + "::" + map[bool]string{true: "bigint", false: "text"}[table == "library_files"] + "[]," + column + ")"
		clauses, order = append(clauses, position+" is not null"), position+","+order
	}
	projection := libraryProjection(table)
	if len(projections) > 0 {
		projection = projections[0]
	}
	query := "select " + projection + " from " + table + " r where " + strings.Join(clauses, " and ") + " order by " + order + window
	rows, err := s.pool.Query(ctx, query, a...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var v T
		if err = rows.Scan(&raw); err != nil {
			return out, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func libraryItemFilter(table, item string) string {
	switch table {
	case "library_activity":
		return "r.item_id=" + item
	case "library_files":
		return "exists(select 1 from library_item_files f where f.file_id=r.id and f.item_id=" + item + ")"
	}
	return "true"
}

func libraryFilters(o library.ListOptions) (search.Filters, error) {
	f := search.Filters{Source: o.Source, Account: o.Account, Kind: o.Kind}
	for _, boundary := range []struct {
		value string
		at    *time.Time
	}{{o.Since, &f.Since}, {o.Until, &f.Until}} {
		if boundary.value == "" {
			continue
		}
		at, err := ParseBoundary(boundary.value)
		if err != nil {
			return f, err
		}
		*boundary.at = at
	}
	return f, nil
}

// rankLibrary ranks a library table's records for a list with a query: the
// page o asks for, as record ids, or as content ids for files, which match
// by name or by the text read from them.
func (s *Store) rankLibrary(ctx context.Context, table string, o library.ListOptions, f search.Filters) (any, error) {
	q, err := search.Parse(o.Query, search.Mode(o.Match))
	if err != nil {
		return nil, err
	}
	q.Exact = o.Exact
	f.Kind = f.Subkind()
	n := o.Offset + o.Limit
	item := func(a *args) string {
		if o.ItemID == "" {
			return ""
		}
		return " and " + libraryItemFilter(table, a.next(o.ItemID))
	}
	hits, _, err := search.Rank(q, o.Offset, o.Limit, func(q search.Query) (lists []search.List, err error) {
		add := func(list search.List, err error) error {
			lists = append(lists, list)
			return err
		}
		switch table {
		case "library_items":
			err = add(s.searchLibrary(ctx, ItemList, q, f, n, item))
		case "library_activity":
			err = add(s.searchLibrary(ctx, ActivityList, q, f, n, item))
		case "library_collections":
			err = add(s.searchLibrary(ctx, CollectionList, q, f, n, item))
		case "library_pages":
			err = add(s.searchLibrary(ctx, PageList, q, f, n, item))
		case "library_files":
			err = errors.Join(add(s.searchLibrary(ctx, LibraryFileList, q, f, n, item)), add(s.searchTexts(ctx, q, search.Filters{}, n, func(a *args) string {
				where, _ := LibraryFileList.filters(f, a)
				return " and exists (select 1 from library_files r where r.content_id = t.content_id" + where + item(a) + ")"
			})))
		}
		return lists, err
	})
	if err != nil {
		return nil, err
	}
	if table == "library_files" {
		ids := make([]int64, len(hits))
		for i, h := range hits {
			ids[i] = h.ContentID
		}
		return ids, nil
	}
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.Ref
	}
	return ids, nil
}

func getLibrary[T any](ctx context.Context, s *Store, table, id string) (T, error) {
	var v T
	var raw []byte
	err := s.pool.QueryRow(ctx, "select "+libraryProjection(table)+" from "+table+" r where r.id=$1", id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}

func (s *Store) ListLibraryItems(ctx context.Context, o library.ListOptions) ([]library.Item, error) {
	return listLibrary[library.Item](ctx, s, "library_items", o)
}
func (s *Store) ListLibraryActivity(ctx context.Context, o library.ListOptions) ([]library.Activity, error) {
	return listLibrary[library.Activity](ctx, s, "library_activity", o)
}
func (s *Store) ListLibraryCollections(ctx context.Context, o library.ListOptions) ([]library.Collection, error) {
	return listLibrary[library.Collection](ctx, s, "library_collections", o)
}
func (s *Store) ListLibraryCollectionSummaries(ctx context.Context, o library.ListOptions) ([]library.CollectionSummary, error) {
	return listLibrary[library.CollectionSummary](ctx, s, "library_collections", o, libraryCollectionSummaryJSON)
}
func (s *Store) ListLibraryFiles(ctx context.Context, o library.ListOptions) ([]library.File, error) {
	return listLibrary[library.File](ctx, s, "library_files", o)
}
func (s *Store) ListLibraryPages(ctx context.Context, o library.ListOptions) ([]library.Page, error) {
	return listLibrary[library.Page](ctx, s, "library_pages", o)
}
func (s *Store) LibraryItem(ctx context.Context, id string) (library.Item, error) {
	return getLibrary[library.Item](ctx, s, "library_items", id)
}
func (s *Store) LibraryActivity(ctx context.Context, id string) (library.Activity, error) {
	return getLibrary[library.Activity](ctx, s, "library_activity", id)
}
func (s *Store) LibraryCollection(ctx context.Context, id string) (library.Collection, error) {
	return getLibrary[library.Collection](ctx, s, "library_collections", id)
}
func (s *Store) LibraryFile(ctx context.Context, id string) (library.File, error) {
	return getLibrary[library.File](ctx, s, "library_files", id)
}
func (s *Store) LibraryPage(ctx context.Context, id string) (library.Page, error) {
	return getLibrary[library.Page](ctx, s, "library_pages", id)
}

func (s *Store) LibraryCollectionSnapshots(ctx context.Context, id string) ([]library.Snapshot, error) {
	return collectionSnapshots[library.Snapshot](ctx, s, id, librarySnapshotJSON, library.ListOptions{}, false)
}

func (s *Store) LibraryCollectionSnapshotSummaries(ctx context.Context, id string, o library.ListOptions) ([]library.SnapshotSummary, error) {
	return collectionSnapshots[library.SnapshotSummary](ctx, s, id, librarySnapshotSummaryJSON, o, true)
}

func collectionSnapshots[T any](ctx context.Context, s *Store, id, projection string, o library.ListOptions, paginated bool) ([]T, error) {
	out := []T{}
	if err := o.Validate(); err != nil {
		return out, err
	}
	var exists bool
	if err := s.pool.QueryRow(ctx, `select exists(select 1 from library_collections where id=$1)`, id).Scan(&exists); err != nil {
		return out, err
	}
	if !exists {
		return out, ErrNotFound
	}
	query := `select ` + projection + ` from library_snapshots s where collection_id=$1 order by id desc`
	args := []any{id}
	if paginated {
		o.Limit = page.Limit(o.Limit)
		query += ` limit $2 offset $3`
		args = append(args, o.Limit, o.Offset)
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var v T
		if err = rows.Scan(&raw); err != nil {
			return out, err
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) LibraryCollectionSnapshot(ctx context.Context, collectionID string, snapshotID int64) (library.Snapshot, error) {
	var snapshot library.Snapshot
	var raw []byte
	err := s.pool.QueryRow(ctx, `select `+librarySnapshotJSON+` from library_snapshots s where collection_id=$1 and id=$2`, collectionID, snapshotID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, ErrNotFound
	}
	if err != nil {
		return snapshot, err
	}
	err = json.Unmarshal(raw, &snapshot)
	return snapshot, err
}

func (s *Store) LibraryItemSummaries(ctx context.Context, ids []string) ([]library.ItemSummary, error) {
	out := []library.ItemSummary{}
	if err := (library.ItemSummaryRequest{IDs: ids}).Validate(); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `select i.id,i.title,i.kind,i.source from library_items i join (select id,min(position) position from unnest($1::text[]) with ordinality requested(id,position) group by id) requested on requested.id=i.id order by requested.position`, libraryStrings(ids))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item library.ItemSummary
		if err := rows.Scan(&item.ID, &item.Title, &item.Kind, &item.Source); err != nil {
			return out, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
