package store

import (
	"context"
	"fmt"
	"time"
)

type BrowseOpts struct {
	Source, Order string
	Limit, Offset int
}

func (o BrowseOpts) Validate() error {
	if o.Order != "" && o.Order != "asc" && o.Order != "desc" {
		return fmt.Errorf("order must be asc or desc")
	}
	if o.Limit < 1 || o.Limit > MaxSearchLimit {
		return fmt.Errorf("limit must be 1-%d", MaxSearchLimit)
	}
	if o.Offset < 0 || o.Offset > MaxSearchOffset {
		return fmt.Errorf("offset must be 0-%d", MaxSearchOffset)
	}
	return nil
}

type ThreadGroup struct {
	Source   string    `json:"source"`
	ThreadID string    `json:"thread_id"`
	Count    int64     `json:"n"`
	LastAt   time.Time `json:"last_at"`
	LastID   int64     `json:"last_id"`
	Sender   string    `json:"sender"`
	Subject  string    `json:"subject"`
	Preview  string    `json:"preview"`
	Members  string    `json:"members"`
}

func (s *Store) BrowseThreads(ctx context.Context, o BrowseOpts) ([]ThreadGroup, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	order := "desc"
	if o.Order == "asc" {
		order = "asc"
	}
	// Empty thread ids remain individual messages. Order ties include source
	// and identity so pagination cannot shuffle equal-time conversations.
	rows, err := s.pool.Query(ctx, `select source, thread_id, count(*), max(sent_at),
		(array_agg(id order by sent_at desc,id desc))[1],
		(array_agg(sender order by sent_at desc,id desc))[1],
		coalesce((array_agg(nullif(subject,'') order by sent_at desc,id desc)
			filter(where subject<>''))[1],''),
		(array_agg(left(body,240) order by sent_at desc,id desc))[1],
		left(string_agg(distinct nullif(sender,''),', ' order by nullif(sender,''))
			filter(where sender !~* '^thomas( breindl)?$'),200)
		from messages where ($1='' or source=$1)
		group by source, thread_id, case when thread_id='' then id else 0 end
		order by max(sent_at) `+order+`, source, thread_id, min(id)
		limit $2 offset $3`, o.Source, o.Limit, o.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ThreadGroup{}
	for rows.Next() {
		var g ThreadGroup
		var members *string
		if err := rows.Scan(&g.Source, &g.ThreadID, &g.Count, &g.LastAt, &g.LastID, &g.Sender, &g.Subject, &g.Preview, &members); err != nil {
			return nil, err
		}
		if members != nil {
			g.Members = *members
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
