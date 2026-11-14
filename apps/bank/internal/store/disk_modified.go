package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Modified lists present files last modified in [since, until), oldest first.
func (s *Store) Modified(ctx context.Context, since, until time.Time, limit int) ([]Hit, error) {
	rows, err := s.pool.Query(ctx, `select `+hitColumns+` from (
		select e.id, e.volume_id, e.kind, e.path, e.size_bytes, e.modified_at, e.missing_scan, e.content_id
		from entries e
		where e.kind = 'file' and e.missing_scan is null and e.modified_at >= $1 and e.modified_at < $2
		order by e.modified_at, e.id limit $3) e`+hitJoins+` order by e.modified_at, e.id`, since, until, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Hit, error) { return scanHit(r) })
}
