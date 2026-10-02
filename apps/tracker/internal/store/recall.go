package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

// Visits summarises page views: how many, the first and last start, and the
// active time of their spans. FirstAt and LastAt are nil when Count is 0.
type Visits struct {
	Count         int64      `json:"count"`
	FirstAt       *time.Time `json:"first_at"`
	LastAt        *time.Time `json:"last_at"`
	ActiveSeconds int64      `json:"active_seconds"`
}

type keyedVisits struct {
	Key int64
	Visits
}

// visitsByKey summarises the page views a query lists as (key, page_view_id)
// pairs into one Visits per key. Which page views count is the caller's
// query; how they are counted lives here, once.
func visitsByKey(ctx context.Context, db bun.IDB, matched string, args ...any) (map[int64]Visits, error) {
	var rows []keyedVisits
	err := db.NewRaw(`with matched (key, page_view_id) as (`+matched+`)
		select m.key, count(*) as count, min(pv.started_at) as first_at, max(pv.started_at) as last_at,
			coalesce(round(sum(s.seconds)), 0)::bigint as active_seconds
		from (select distinct key, page_view_id from matched) m
		join page_views pv on pv.id = m.page_view_id
		left join lateral (select sum(extract(epoch from a.ended_at - a.started_at)) as seconds
			from activity_spans a where a.page_view_id = pv.id) s on true
		group by m.key`, args...).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	visits := make(map[int64]Visits, len(rows))
	for _, r := range rows {
		visits[r.Key] = r.Visits
	}
	return visits, nil
}

// recordVisits counts, per record, the page views that captured any of its
// blobs and the page views of its canonical URL.
func recordVisits(ctx context.Context, db bun.IDB, ids []int64) (map[int64]Visits, error) {
	return visitsByKey(ctx, db, `select d.record_id, c.page_view_id from derivations d
			join captures c on c.raw_hash = d.raw_hash
			where d.record_id = any(?0)
		union all
		select r.id, pv.id from records r
			join urls u on u.normalized_url = r.canonical_url
			join page_views pv on pv.url_id = u.id
			where r.id = any(?0)`, pgdialect.Array(ids))
}

// URLVisits counts the page views of the page whose normalised URL hashes to
// urlHash; a non-zero before keeps only those that started earlier.
func (s *Store) URLVisits(ctx context.Context, urlHash []byte, before time.Time) (Visits, error) {
	visits, err := visitsByKey(ctx, s.db, `select 0, pv.id from page_views pv
		join urls u on u.id = pv.url_id
		where u.url_hash = ?0 and (?1::timestamptz is null or pv.started_at < ?1)`,
		urlHash, sql.NullTime{Time: before, Valid: !before.IsZero()})
	return visits[0], err
}

type RecordDetail struct {
	ID           int64           `json:"id"`
	Extractor    string          `json:"extractor"`
	Title        string          `json:"title"`
	CanonicalURL string          `json:"canonical_url"`
	SearchText   string          `json:"search_text"`
	Data         json.RawMessage `json:"data"`
	FirstSeenAt  time.Time       `json:"first_seen_at"`
	LastSeenAt   time.Time       `json:"last_seen_at"`
	Visits       Visits          `json:"visits" bun:"-"`
}

func (s *Store) Record(ctx context.Context, id int64) (RecordDetail, error) {
	var r RecordDetail
	err := s.db.NewRaw(`select id, extractor, coalesce(title, '') as title, canonical_url, search_text, data,
			first_seen_at, last_seen_at
		from records where id = ?`, id).Scan(ctx, &r)
	if errors.Is(err, sql.ErrNoRows) {
		return RecordDetail{}, ErrNotFound
	}
	if err != nil {
		return RecordDetail{}, err
	}
	visits, err := recordVisits(ctx, s.db, []int64{id})
	r.Visits = visits[id]
	return r, err
}
