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
		select m.sent_at, false, 'message', m.source, `+refSQL("m")+`,
			coalesce(nullif(m.subject, ''), left(m.body, 120))
		from messages m where m.sent_at >= $1 and m.sent_at < $2
		order by m.sent_at, m.id limit $3`, since, until, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scanDated)
}

// ActivityBetween lists watching, listening, reading and the like whose day
// falls in [since, until), oldest first. Activity without a date is left out.
func (s *Store) ActivityBetween(ctx context.Context, since, until time.Time, limit int) ([]Dated, error) {
	// The day is the first ten characters of both a date and an instant.
	rows, err := s.pool.Query(ctx, `
		select case when a.occurred->>'precision' = 'instant' then (a.occurred->>'value')::timestamptz
				else (a.occurred->>'value')::date::timestamptz end,
			a.occurred->>'precision' = 'day', a.kind, a.source, a.id, a.title
		from library_activity a
		where a.occurred->>'precision' <> 'unknown'
			and left(a.occurred->>'value', 10) >= $1 and left(a.occurred->>'value', 10) < $2
		order by a.occurred->>'value', a.id limit $3`,
		since.Format(time.DateOnly), until.Format(time.DateOnly), limit)
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
