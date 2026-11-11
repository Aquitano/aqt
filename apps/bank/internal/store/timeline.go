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

// ActivityBetween lists watching, listening, reading and the like that falls
// in [since, until), oldest first. An instant is compared as one, whatever
// offset the source wrote; a day without a time falls in the window when
// that calendar day does. Activity without a date is left out.
func (s *Store) ActivityBetween(ctx context.Context, since, until time.Time, limit int) ([]Dated, error) {
	rows, err := s.pool.Query(ctx, `
		select a.at, a.day_only, a.kind, a.source, a.id, a.title from (
			select case when a.occurred->>'precision' = 'instant' then (a.occurred->>'value')::timestamptz
					else (a.occurred->>'value')::date::timestamptz end as at,
				a.occurred->>'precision' = 'day' as day_only,
				a.occurred->>'value' as value,
				a.kind, a.source, a.id, a.title
			from library_activity a
			where a.occurred->>'precision' in ('instant', 'day')) a
		where case when a.day_only then a.value::date >= $3::date and a.value::date < $4::date
			else a.at >= $1 and a.at < $2 end
		order by a.at, a.id limit $5`,
		since, until, since.Format(time.DateOnly), until.Format(time.DateOnly), limit)
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
