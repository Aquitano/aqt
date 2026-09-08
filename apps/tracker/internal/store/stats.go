package store

import (
	"context"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

type Stats struct {
	URLs            int64            `json:"urls"`
	PageViews       int64            `json:"page_views"`
	ActivitySpans   int64            `json:"activity_spans"`
	ActiveSeconds   float64          `json:"active_seconds"`
	Blobs           int64            `json:"blobs"`
	BlobRawBytes    int64            `json:"blob_raw_bytes"`
	BlobStoredBytes int64            `json:"blob_stored_bytes"`
	Captures        int64            `json:"captures"`
	Derivations     map[string]int64 `json:"derivations"`
	Records         map[string]int64 `json:"records"`
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	st := Stats{Derivations: map[string]int64{}, Records: map[string]int64{}}
	err := s.db.NewRaw(`select
			(select count(*) from urls),
			(select count(*) from page_views),
			(select count(*) from activity_spans),
			(select coalesce(sum(extract(epoch from ended_at - started_at)), 0) from activity_spans),
			(select count(*) from raw_html_blobs),
			(select coalesce(sum(raw_bytes), 0) from raw_html_blobs),
			(select coalesce(sum(stored_bytes), 0) from raw_html_blobs),
			(select count(*) from captures)`).
		Scan(ctx, &st.URLs, &st.PageViews, &st.ActivitySpans, &st.ActiveSeconds,
			&st.Blobs, &st.BlobRawBytes, &st.BlobStoredBytes, &st.Captures)
	if err != nil {
		return Stats{}, err
	}
	if err := groupCounts(ctx, s.db, `select status, count(*) from derivations group by status`, st.Derivations); err != nil {
		return Stats{}, err
	}
	if err := groupCounts(ctx, s.db, `select extractor, count(*) from records group by extractor`, st.Records); err != nil {
		return Stats{}, err
	}
	return st, nil
}

func groupCounts(ctx context.Context, db *bun.DB, query string, into map[string]int64) error {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var n int64
		if err := rows.Scan(&key, &n); err != nil {
			return err
		}
		into[key] = n
	}
	return rows.Err()
}

var Tables = []string{"urls", "page_views", "activity_spans", "raw_html_blobs", "captures", "derivations", "records"}

func (s *Store) TableBytes(ctx context.Context) (map[string]int64, error) {
	sizes := map[string]int64{}
	rows, err := s.db.QueryContext(ctx, `select t, pg_total_relation_size(t::regclass) from unnest(?::text[]) as t`,
		pgdialect.Array(Tables))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var n int64
		if err := rows.Scan(&name, &n); err != nil {
			return nil, err
		}
		sizes[name] = n
	}
	return sizes, rows.Err()
}
