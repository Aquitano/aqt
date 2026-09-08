package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

type SearchOpts struct {
	Query     string
	Extractor string
	Limit     int
}

const MaxSearchLimit = 100

type Hit struct {
	ID           int64           `json:"id"`
	Extractor    string          `json:"extractor"`
	Title        string          `json:"title"`
	CanonicalURL string          `json:"canonical_url"`
	Snippet      string          `json:"snippet"`
	Score        float64         `json:"score"`
	LastSeenAt   time.Time       `json:"last_seen_at"`
	Data         json.RawMessage `json:"data"`
}

func (s *Store) Search(ctx context.Context, o SearchOpts) ([]Hit, error) {
	if o.Query == "" {
		return nil, fmt.Errorf("empty query")
	}
	if o.Limit < 1 || o.Limit > MaxSearchLimit {
		return nil, fmt.Errorf("limit must be 1-%d", MaxSearchLimit)
	}
	q := s.db.NewSelect().TableExpr("records r").
		ColumnExpr("r.id, r.extractor, coalesce(r.title, '') as title, coalesce(r.canonical_url, '') as canonical_url").
		ColumnExpr("coalesce(paradedb.snippet(r.search_text, '', '', 160), '') as snippet").
		ColumnExpr("paradedb.score(r.id) as score, r.last_seen_at, r.data").
		Where("r.id @@@ paradedb.boolean(should => array[paradedb.match('title', ?, distance => 1), paradedb.match('search_text', ?, distance => 1)])", o.Query, o.Query).
		OrderExpr("paradedb.score(r.id) desc, r.last_seen_at desc, r.id desc").
		Limit(o.Limit)
	if o.Extractor != "" {
		q = q.Where("r.extractor = ?", o.Extractor)
	}
	rows := []hitRow{}
	if err := q.ColumnExpr("r.search_text").Scan(ctx, &rows); err != nil {
		return nil, err
	}
	hits := make([]Hit, 0, len(rows))
	for _, row := range rows {
		if row.Snippet == "" {
			row.Snippet = cutSnippet(row.SearchText, o.Query, snippetWidth)
		}
		hits = append(hits, row.Hit)
	}
	return hits, nil
}

// pg_search produces no snippet for a fuzzy match, so a window around the
// first query term stands in.
const snippetWidth = 160

type hitRow struct {
	Hit
	SearchText string `bun:"search_text"`
}

func cutSnippet(text, query string, width int) string {
	lower := strings.ToLower(text)
	start := -1
	for _, term := range strings.Fields(strings.ToLower(query)) {
		if i := strings.Index(lower, term); i >= 0 && (start < 0 || i < start) {
			start = i
		}
	}
	if start < 0 {
		start = 0
	}
	start = max(0, start-width/4)
	for start > 0 && !utf8.RuneStart(text[start]) {
		start--
	}
	end := min(len(text), start+width)
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	return strings.Join(strings.Fields(text[start:end]), " ")
}
