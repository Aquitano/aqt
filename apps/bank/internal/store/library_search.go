package store

import (
	"context"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/search"
)

// LibraryList names one of the library's ranked lists.
type LibraryList struct {
	name, kind, table string
	fields            []search.Field
	// kinds are the values the table's kind column takes, nil without one.
	kinds []string
	// title and snippet are columns; dated tables have occurred_at.
	title, snippet string
	dated          bool
}

var (
	ItemList = LibraryList{name: "items", kind: search.KindItem, table: "library_items", kinds: search.ItemKinds,
		title: "title", snippet: "description", fields: []search.Field{{Name: "title", Boost: 3}, {Name: "description"},
			{Name: "creators", Boost: 2}, {Name: "series", Boost: 2}, {Name: "album", Boost: 2}, {Name: "provider_id"},
			{Name: "state_notes"}, {Name: "state_tags", Boost: 2}}}
	ActivityList = LibraryList{name: "activity", kind: search.KindActivity, table: "library_activity", kinds: search.ActivityKinds,
		title: "title", dated: true, fields: []search.Field{{Name: "title"}}}
	CollectionList = LibraryList{name: "collections", kind: search.KindCollection, table: "library_collections", kinds: search.CollectionKinds,
		title: "title", snippet: "description", fields: []search.Field{{Name: "title", Boost: 3}, {Name: "description"}}}
	PageList = LibraryList{name: "pages", kind: search.KindPage, table: "library_pages", title: "title", snippet: "body",
		fields: []search.Field{{Name: "title", Boost: 3}, {Name: "aliases", Boost: 3}, {Name: "body"}, {Name: "answers"}, {Name: "tags", Boost: 2}}}
	LibraryFileList = LibraryList{name: "library file name", kind: search.KindFile, table: "library_files", title: "filename",
		fields: filenameField}
)

// libraryFilters are f's filters a library table has, all of them fields of
// its BM25 index. ok is false when the table cannot apply a filter that is set.
func (l LibraryList) filters(f search.Filters, a *args) (where string, ok bool) {
	if f.MessageScoped() || (f.Dated() && !l.dated) || !f.Wants(l.kind) {
		return "", false
	}
	if f.Source != "" {
		where += " and r.source = " + a.next(f.Source)
	}
	if f.Account != "" {
		where += " and r.account = " + a.next(f.Account)
	}
	if kind := f.Subkind(); kind != "" && l.kinds != nil {
		if !slices.Contains(l.kinds, kind) {
			return "", false
		}
		where += " and r.kind = " + a.next(kind)
	}
	if l.dated {
		where += occurredBetween("r", f.Since, f.Until, a)
	}
	return where, true
}

// occurredBetween keeps an instant inside [since, until) and a day whose date
// falls in the dates of since and until. Undated records are left out of a
// dated query.
func occurredBetween(alias string, since, until time.Time, a *args) string {
	if since.IsZero() && until.IsZero() {
		return ""
	}
	instant, day := alias+".occurred_precision = 'instant'", alias+".occurred_precision = 'day'"
	if !since.IsZero() {
		instant += " and " + alias + ".occurred_at >= " + a.next(since)
		day += " and " + alias + ".occurred_at >= " + a.next(utcDay(since))
	}
	if !until.IsZero() {
		instant += " and " + alias + ".occurred_at < " + a.next(until)
		day += " and " + alias + ".occurred_at < " + a.next(utcDay(until))
	}
	return " and ((" + instant + ") or (" + day + "))"
}

// utcDay is the UTC midnight of t's calendar day where t is, which is how a
// day without a time is stored.
func utcDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// SearchLibrary ranks one library list's records. It returns an empty list
// when the list cannot apply a filter f sets.
func (s *Store) SearchLibrary(ctx context.Context, l LibraryList, q search.Query, f search.Filters, n int) (search.List, error) {
	return s.searchLibrary(ctx, l, q, f, n, nil)
}

// searchLibrary also applies extra, a predicate over r, when it is set.
func (s *Store) searchLibrary(ctx context.Context, l LibraryList, q search.Query, f search.Filters, n int, extra func(*args) string) (search.List, error) {
	list := search.List{Name: l.name, Kind: l.kind}
	var a args
	where, ok := l.filters(f, &a)
	if !ok {
		return list, nil
	}
	cond := "r.seq @@@ " + q.Clause(l.fields, a.next) + where
	if extra != nil {
		cond += extra(&a)
	}
	kind, snippet, at, precision, content := "''", "''", "null::timestamptz", "''", "0::bigint"
	if l.kinds != nil {
		kind = "r.kind"
	}
	if l.snippet != "" {
		snippet = "coalesce(paradedb.snippet(r." + l.snippet + ", '', '', " + strconv.Itoa(snippetChars) + "), '')"
	}
	if l.dated {
		at, precision = "r.occurred_at", "r.occurred_precision"
	}
	if l.kind == search.KindFile {
		content = "r.content_id"
	}
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx,
		`select r.id, `+kind+`, r.`+l.title+`, r.source, `+snippet+`, `+at+`, `+precision+`, `+content+`
		from `+l.table+` r where `+cond+` order by paradedb.score(r.seq) desc, r.seq limit `+strconv.Itoa(n),
		`select count(*) from `+l.table+` r where `+cond, a,
		func(row pgx.CollectableRow) (search.SearchHit, error) {
			h := search.SearchHit{Kind: l.kind}
			var id, engine, dated string
			err := row.Scan(&id, &h.Type, &h.Title, &h.Source, &engine, &h.At, &dated, &h.ContentID)
			h.Ref, h.Key, h.DayOnly = id, id, dated == "day"
			h.Snippet = Snippet(engine, "", "")
			if l.kind == search.KindFile {
				h.Ref, h.Key = "", search.ContentKey(h.ContentID)
			}
			return h, err
		})
	return list, err
}
