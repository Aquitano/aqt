package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// The tokenizers searchWords casts query words to. ParadeDB records each
// tokenizer configuration the first time it parses one, in
// paradedb._typmod_cache. A read-only session cannot make that write, so Open
// parses these once with write access.
const (
	wordTokenizer = `pdb.unicode_words('ascii_folding=true')`
	codeTokenizer = `pdb.source_code('ascii_folding=true')`
	gramTokenizer = `pdb.ngram(3, 3, 'ascii_folding=true')`
)

const recordTokenizers = `select null::` + wordTokenizer + `, null::` + codeTokenizer + `, null::` + gramTokenizer

func (s *Store) searchWords(ctx context.Context, words []string, names bool) ([]string, error) {
	if len(words) == 0 {
		return nil, nil
	}
	tokens := `cardinality(pdb.tokenize_unicode_words(word::` + wordTokenizer + `)) > 0`
	if names {
		tokens = `cardinality(pdb.tokenize_source_code(word::` + codeTokenizer + `)) > 0
   or cardinality(pdb.tokenize_ngram(word::` + gramTokenizer + `)) > 0`
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
	q.where = append(q.where, key+" @@@ "+searchBoolean(clauses, o.Any))
	place := []string{"e.content_id = " + contentID}
	place = append(place, q.entryFilters(copiesOf(o, false))...)
	q.where = append(q.where, "exists (select 1 from entries e where "+strings.Join(place, " and ")+")")
	return q, nil
}
