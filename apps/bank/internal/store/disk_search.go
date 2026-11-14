package store

import (
	"strings"
	"unicode"

	"github.com/aquitano/aqt/apps/bank/internal/search"
)

var (
	nameFields = []search.Field{{Name: "name", Boost: 3}, {Name: "path"}, {Name: "name_ngram", Fragment: true}}
)

// parseQuery reads o.Query with the archive's one grammar. ok is false when
// it holds no letter or digit, which matches nothing rather than everything.
func parseQuery(o SearchOptions) (q search.Query, ok bool, err error) {
	if !strings.ContainsFunc(o.Query, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) {
		return q, false, nil
	}
	if q, err = search.Parse(o.Query, o.Match); err != nil {
		return q, false, &InvalidSearchError{err.Error()}
	}
	q.Exact = o.Exact
	return q, true, nil
}

func searchExt(ext string) string {
	return strings.ToLower(strings.TrimPrefix(ext, "."))
}

func (q *diskSearch) entryFilters(c copies) []string {
	var where []string
	switch len(c.volumes) {
	case 0:
	case 1:
		where = append(where, "e.volume_id = "+q.next(c.volumes[0]))
	default:
		where = append(where, "e.volume_id = any("+q.next(c.volumes)+"::uuid[])")
	}
	if c.under != "" {
		path := strings.TrimSuffix(c.under, "/")
		under := `(e.path collate "C" > ` + q.next(path+"/") + ` and e.path collate "C" < ` + q.next(path+"0") + `)`
		if c.self {
			under = `(e.path = ` + q.next(path) + ` or ` + under + `)`
		}
		where = append(where, under)
	}
	if c.ext != nil {
		where = append(where, "e.ext = "+q.next(*c.ext))
	}
	return where
}

func (s *Store) newTextSearch(o SearchOptions, key, contentID string) (*diskSearch, error) {
	if o.Kind != "" && o.Kind != "file" {
		return nil, nil
	}
	parsed, ok, err := parseQuery(o)
	if err != nil || !ok {
		return nil, err
	}
	q := &diskSearch{order: "paradedb.score(" + key + ") desc, " + key}
	q.where = append(q.where, key+" @@@ "+parsed.Clause(textFields, q.next), q.holders(contentID, copiesOf(o, false)))
	return q, nil
}

// holders requires an entry within the filters that holds the content now
// or, when c includes previous versions, held it before its bytes changed.
// The open version stands for the current content, so one EXISTS covers
// both: Postgres turns it into a semi join, where an OR of two EXISTS
// became hashed subplans that read every version.
func (q *diskSearch) holders(contentID string, c copies) string {
	place := []string{"e.content_id = " + contentID}
	from := "entries e"
	if c.previous {
		place = []string{"ver.content_id = " + contentID}
		from = "entry_versions ver join entries e on e.id = ver.entry_id"
	}
	place = append(place, q.entryFilters(c)...)
	return "exists (select 1 from " + from + " where " + strings.Join(place, " and ") + ")"
}
