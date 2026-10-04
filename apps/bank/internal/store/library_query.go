package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/jackc/pgx/v5"
)

const librarySnapshotJSON = `(to_jsonb(s)-'collection_id') || jsonb_build_object('entries',coalesce((select jsonb_agg(to_jsonb(e)-'snapshot_id' order by e.position) from library_entries e where e.snapshot_id=s.id),'[]'::jsonb))`
const librarySnapshotSummaryJSON = `(to_jsonb(s)-'collection_id') || jsonb_build_object('entry_count',(select count(*) from library_entries e where e.snapshot_id=s.id))`
const librarySnapshotOrder = `case s.captured->>'precision' when 'instant' then (s.captured->>'value')::timestamptz when 'day' then (s.captured->>'value')::date::timestamp at time zone 'UTC' end desc nulls last,s.id desc`
const libraryItemJSON = `(to_jsonb(r)-'search_text') || jsonb_build_object('evidence',coalesce((select jsonb_agg(jsonb_build_object('raw_ref',e.raw_ref,'locator',e.locator) order by e.raw_ref,e.locator) from library_item_evidence e where e.item_id=r.id),'[]'::jsonb),'state',coalesce((select to_jsonb(st)-'item_id' from library_state st where st.item_id=r.id),'{"revision":0,"status":"","favorite":false,"progress":0,"progress_unit":"","notes":"","tags":[]}'::jsonb),'file_ids',coalesce((select jsonb_agg(f.file_id order by f.file_id) from library_item_files f where f.item_id=r.id),'[]'::jsonb))`
const libraryCollectionJSON = `(to_jsonb(r)-'search_text') || jsonb_build_object('snapshot',(select ` + librarySnapshotJSON + ` from library_snapshots s where s.collection_id=r.id order by case s.captured->>'precision' when 'instant' then (s.captured->>'value')::timestamptz when 'day' then (s.captured->>'value')::date::timestamp at time zone 'UTC' end desc nulls last,s.id desc limit 1))`
const libraryCollectionSummaryJSON = `(to_jsonb(r)-'search_text') || jsonb_build_object('snapshot',(select ` + librarySnapshotSummaryJSON + ` from library_snapshots s where s.collection_id=r.id order by ` + librarySnapshotOrder + ` limit 1))`
const libraryActivityJSON = `(to_jsonb(r)-'search_text') || jsonb_build_object('evidence',coalesce((select jsonb_agg(jsonb_build_object('raw_ref',e.raw_ref,'locator',e.locator) order by e.raw_ref,e.locator) from library_activity_evidence e where e.activity_id=r.id),'[]'::jsonb))`
const libraryFileJSON = `(to_jsonb(r)-'search_text'-'ingested_at') || jsonb_build_object('item_ids',coalesce((select jsonb_agg(f.item_id order by f.item_id) from library_item_files f where f.file_id=r.id),'[]'::jsonb),'text_status',coalesce((select status from blob_text where sha256=r.sha256),'pending'))`

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
		return "to_jsonb(r)-'search_text'"
	}
}

func libraryBoundary(v string) (time.Time, error) {
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
	if o.Limit == 0 {
		o.Limit = 50
	}
	args := []any{}
	next := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	clauses := []string{"true"}
	ctes := ""
	if o.Source != "" {
		clauses = append(clauses, "r.source="+next(o.Source))
	}
	if o.Account != "" {
		clauses = append(clauses, "r.account="+next(o.Account))
	}
	if o.Kind != "" && table != "library_files" && table != "library_pages" {
		clauses = append(clauses, "r.kind="+next(o.Kind))
	}
	if o.ItemID != "" {
		if table == "library_activity" {
			clauses = append(clauses, "r.item_id="+next(o.ItemID))
		}
		if table == "library_files" {
			clauses = append(clauses, "exists(select 1 from library_item_files f where f.file_id=r.id and f.item_id="+next(o.ItemID)+")")
		}
	}
	if o.Query != "" {
		q := next(o.Query)
		match := libraryTextQuery(o.Match, q)
		predicate := "to_tsvector('simple',r.search_text) @@ " + match
		if table == "library_files" {
			ctes = "with text_matches as materialized(select sha256,search_vector from blob_text where status in ('ok','manual') and search_vector @@ " + libraryTextQuery("any", q) + " union all select sha256,blob_text_query_vector(text," + q + ") from blob_text where status in ('ok','manual') and search_vector is null) "
			predicate = "(to_tsvector('simple',r.search_text || ' ' || regexp_replace(r.filename,'[._-]+',' ','g')) || coalesce((select bt.search_vector from text_matches bt where bt.sha256=r.sha256),''::tsvector)) @@ " + match
		}
		if table == "library_items" {
			stateVector := "to_tsvector('simple',st.notes || ' ' || array_to_string(st.tags,' '))"
			if o.Match == "all" {
				stateVector = "(to_tsvector('simple',r.search_text) || " + stateVector + ")"
			}
			predicate = "(" + predicate + " or exists(select 1 from library_state st where st.item_id=r.id and " + stateVector + " @@ " + match + "))"
		}
		clauses = append(clauses, predicate)
	}
	if table == "library_activity" {
		for _, boundary := range []struct{ value, operator string }{{o.Since, ">="}, {o.Until, "<"}} {
			if boundary.value == "" {
				continue
			}
			at, err := libraryBoundary(boundary.value)
			if err != nil {
				return out, err
			}
			day, instant := next(at.Format("2006-01-02")), next(at)
			clauses = append(clauses, "(case r.occurred->>'precision' when 'day' then (r.occurred->>'value')::date "+boundary.operator+" "+day+"::date when 'instant' then (r.occurred->>'value')::timestamptz "+boundary.operator+" "+instant+"::timestamptz else false end)")
		}
	}
	order := "r.id"
	if table == "library_items" || table == "library_collections" || table == "library_pages" {
		order = "lower(r.title),r.id"
	}
	if table == "library_files" {
		order = "lower(r.filename),r.id"
	}
	if table == "library_activity" {
		order = "case r.occurred->>'precision' when 'instant' then (r.occurred->>'value')::timestamptz when 'day' then (r.occurred->>'value')::date::timestamp at time zone 'UTC' end desc nulls last,r.id"
	}
	projection := libraryProjection(table)
	if len(projections) > 0 {
		projection = projections[0]
	}
	query := ctes + "select " + projection + " from " + table + " r where " + strings.Join(clauses, " and ") + " order by " + order + " limit " + next(o.Limit) + " offset " + next(o.Offset)
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
		if o.Limit == 0 {
			o.Limit = 50
		}
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

func (s *Store) SearchLibrary(ctx context.Context, o library.ListOptions) (library.SearchResult, error) {
	result := library.SearchResult{Items: []library.Item{}, Activity: []library.Activity{}, Collections: []library.CollectionSummary{}, Files: []library.File{}, Pages: []library.Page{}, Coverage: []string{"Imported records only; an absent activity is not evidence that an item was not watched.", "Playlist snapshots retain complete, partial or unknown coverage individually."}}
	if err := o.Validate(); err != nil {
		return result, err
	}
	groups := map[string]bool{}
	switch o.Kind {
	case "":
		groups = map[string]bool{"item": true, "activity": true, "collection": true, "file": true, "page": true}
	case "item", "activity", "collection", "file", "page":
		groups[o.Kind] = true
		o.Kind = ""
	case "video", "movie", "series", "episode", "track", "album", "podcast", "book", "article":
		groups["item"] = true
	case "watch", "listen", "read", "play", "view", "purchase":
		groups["activity"] = true
	case "playlist", "library", "watchlist", "list":
		groups["collection"] = true
	case "other":
		groups["item"] = true
		groups["activity"] = true
	default:
		return result, fmt.Errorf("unsupported library kind %q", o.Kind)
	}
	var err error
	if groups["item"] {
		if result.Items, err = s.ListLibraryItems(ctx, o); err != nil {
			return result, err
		}
	}
	if groups["activity"] {
		if result.Activity, err = s.ListLibraryActivity(ctx, o); err != nil {
			return result, err
		}
	}
	if groups["collection"] {
		if result.Collections, err = s.ListLibraryCollectionSummaries(ctx, o); err != nil {
			return result, err
		}
	}
	if groups["file"] {
		if result.Files, err = s.ListLibraryFiles(ctx, o); err != nil {
			return result, err
		}
	}
	if groups["page"] {
		if result.Pages, err = s.ListLibraryPages(ctx, o); err != nil {
			return result, err
		}
	}
	return result, nil
}

func libraryTextQuery(mode, parameter string) string {
	switch mode {
	case "all":
		return "plainto_tsquery('simple'," + parameter + ")"
	case "phrase":
		return "phraseto_tsquery('simple'," + parameter + ")"
	default:
		return "to_tsquery('simple',replace(plainto_tsquery('simple'," + parameter + ")::text,' & ',' | '))"
	}
}
