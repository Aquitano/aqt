package store

import (
	"context"
	"errors"
	"time"
)

var ErrUnknownGrouping = errors.New("by must be host, app or category")

// timeKeys group like the dashboard's panels: browser time by host, desktop
// time by app, both together by category.
var timeKeys = map[string]string{
	"host":     "host",
	"app":      "app_name",
	"category": "coalesce(category, 'uncategorized')",
}

type TimeOpts struct {
	From time.Time
	To   time.Time
	By   string
}

type TimeRow struct {
	Key           string `json:"key"`
	ActiveSeconds int64  `json:"active_seconds"`
}

// Time sums the active seconds per key of the spans overlapping [From, To),
// each clipped to that window.
func (s *Store) Time(ctx context.Context, o TimeOpts) ([]TimeRow, error) {
	key, ok := timeKeys[o.By]
	if !ok {
		return nil, ErrUnknownGrouping
	}
	rows := []TimeRow{}
	err := s.db.NewRaw(`select `+key+` as key,
			round(sum(extract(epoch from least(ended_at, ?1) - greatest(started_at, ?0))))::bigint as active_seconds
		from categorized_spans
		where started_at < ?1 and ended_at > ?0 and `+key+` is not null
		group by 1
		order by 2 desc, 1`, o.From, o.To).Scan(ctx, &rows)
	return rows, err
}
