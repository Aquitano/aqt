package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// QueueStat is one job queue's backlog.
type QueueStat struct {
	Queue string `json:"queue"`
	// Waiting counts jobs available now, scheduled, or waiting to retry.
	Waiting int64 `json:"waiting"`
	Running int64 `json:"running"`
	// Failed counts jobs that used every attempt, kept for seven days.
	Failed int64 `json:"failed"`
	// OldestWaiting is when the longest-waiting available job became due. A
	// queue nobody works shows here first.
	OldestWaiting *time.Time `json:"oldest_waiting,omitempty"`
}

// QueueStats reads River's job table per queue, leaving out completed and
// cancelled jobs.
func (s *Store) QueueStats(ctx context.Context) ([]QueueStat, error) {
	rows, err := s.pool.Query(ctx, `
		select queue,
		       count(*) filter (where state in ('available', 'scheduled', 'retryable')),
		       count(*) filter (where state = 'running'),
		       count(*) filter (where state = 'discarded'),
		       min(scheduled_at) filter (where state = 'available')
		from river_job
		where state in ('available', 'scheduled', 'retryable', 'running', 'discarded')
		group by queue order by queue`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (QueueStat, error) {
		var q QueueStat
		err := r.Scan(&q.Queue, &q.Waiting, &q.Running, &q.Failed, &q.OldestWaiting)
		return q, err
	})
}
