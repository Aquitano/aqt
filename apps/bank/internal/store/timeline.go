package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Dated is one archive record with a time: a message, or library activity.
type Dated struct {
	At time.Time
	// Day means the source recorded a date without a time.
	Day    bool
	Kind   string
	Source string
	Ref    string
	Title  string
}

// MessagesBetween lists messages sent in [since, until), oldest first.
func (s *Store) MessagesBetween(ctx context.Context, since, until time.Time, limit int) ([]Dated, error) {
	rows, err := s.pool.Query(ctx, `
		select m.sent_at, false, 'message', m.source, m.ref,
			coalesce(nullif(m.subject, ''), left(m.body, 120))
		from messages m where m.sent_at >= $1 and m.sent_at < $2
		order by m.sent_at, m.id limit $3`, since, until, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanDated)
}

// ActivityBetween lists watching, listening, reading and the like that falls
// in [since, until), oldest first. An instant is compared as one; a day
// without a time falls in the window when that calendar day does. Activity
// without a date is left out.
func (s *Store) ActivityBetween(ctx context.Context, since, until time.Time, limit int) ([]Dated, error) {
	var a args
	window := occurredBetween("a", since, until, &a)
	rows, err := s.pool.Query(ctx, `
		select a.occurred_at, a.occurred_precision = 'day', a.kind, a.source, a.id, a.title
		from library_activity a where true`+window+`
		order by a.occurred_at, a.id limit `+a.next(limit), a...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanDated)
}

func scanDated(row pgx.CollectableRow) (Dated, error) {
	var d Dated
	err := row.Scan(&d.At, &d.Day, &d.Kind, &d.Source, &d.Ref, &d.Title)
	return d, err
}
