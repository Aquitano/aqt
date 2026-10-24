package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

func (s *Store) searchWords(ctx context.Context, words []string, names bool) ([]string, error) {
	if len(words) == 0 {
		return nil, nil
	}
	tokens := `cardinality(pdb.tokenize_unicode_words(word::pdb.unicode_words('ascii_folding=true'))) > 0`
	if names {
		tokens = `cardinality(pdb.tokenize_source_code(word::pdb.source_code('ascii_folding=true'))) > 0
   or cardinality(pdb.tokenize_ngram(word::pdb.ngram(3, 3, 'ascii_folding=true'))) > 0`
	}
	rows, err := s.pool.Query(ctx, `select word from unnest($1::text[]) with ordinality as words(word, position)
  where `+tokens+` order by position`, words)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func searchExt(ext string) string {
	return strings.ToLower(strings.TrimPrefix(ext, "."))
}

func (q *search) entryFilters(c copies) []string {
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

func searchBoolean(clauses []string, anyWord bool) string {
	mode := "must"
	if anyWord {
		mode = "should"
	}
	return "paradedb.boolean(" + mode + " => array[" + strings.Join(clauses, ", ") + "])"
}

func (s *Store) newTextSearch(ctx context.Context, o SearchOptions, key, contentID string) (*search, error) {
	if o.Kind != "" && o.Kind != "file" {
		return nil, nil
	}
	words, err := s.searchWords(ctx, strings.Fields(o.Query), false)
	if err != nil || len(words) == 0 {
		return nil, err
	}
	q := &search{order: "paradedb.score(" + key + ") desc, " + key}
	clauses := make([]string, len(words))
	for i, word := range words {
		clauses[i] = "paradedb.match('text', " + q.next(word) + ")"
	}
	q.where = append(q.where, key+" @@@ "+searchBoolean(clauses, o.Any), q.holders(contentID, copiesOf(o, false)))
	return q, nil
}

// holders requires an entry within the filters that holds the content now
// or, when c includes previous versions, held it before its bytes changed.
// The open version stands for the current content, so one EXISTS covers
// both: Postgres turns it into a semi join, where an OR of two EXISTS
// became hashed subplans that read every version.
func (q *search) holders(contentID string, c copies) string {
	place := []string{"e.content_id = " + contentID}
	from := "entries e"
	if c.previous {
		place = []string{"ver.content_id = " + contentID}
		from = "entry_versions ver join entries e on e.id = ver.entry_id"
	}
	place = append(place, q.entryFilters(c)...)
	return "exists (select 1 from " + from + " where " + strings.Join(place, " and ") + ")"
}
