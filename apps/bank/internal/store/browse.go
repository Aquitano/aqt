package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type BrowseOpts struct {
	Source, Order             string
	Limit, Offset             int
	MailboxID                 int64
	Subject, From, To, Person string
	HasAttachment             *bool
	Since, Until              time.Time
}

func (o BrowseOpts) Validate() error {
	if err := (SearchOpts{Source: o.Source, MailboxID: o.MailboxID, Limit: o.Limit, Offset: o.Offset, Since: o.Since, Until: o.Until}).Validate(); err != nil {
		return err
	}
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
	if err := s.validateMailbox(ctx, o.Source, o.MailboxID); err != nil {
		return nil, err
	}
	args := []any{o.Source, o.Limit, o.Offset}
	next := func(value any) string { args = append(args, value); return fmt.Sprintf("$%d", len(args)) }
	predicates := mailPredicates(o.MailboxID, o.Subject, o.HasAttachment, next)
	if o.From != "" {
		predicates += " and m.sender ilike " + next("%"+o.From+"%")
	}
	if o.To != "" {
		predicates += " and exists(select 1 from unnest(m.recipients) recipient where recipient ilike " + next("%"+o.To+"%") + ")"
	}
	if !o.Since.IsZero() {
		predicates += " and m.sent_at >= " + next(o.Since)
	}
	if !o.Until.IsZero() {
		predicates += " and m.sent_at < " + next(o.Until)
	}
	if o.Person != "" {
		contact, err := s.GetContact(ctx, o.Person)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return nil, &ErrNoContact{Name: o.Person}
			}
			return nil, err
		}
		predicates += " and" + aliasMatch(next(contact.ID))
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
		from messages m where ($1='' or source=$1)`+predicates+`
		group by source, thread_id, case when thread_id='' then id else 0 end
		order by max(sent_at) `+order+`, source, thread_id, min(id)
		limit $2 offset $3`, args...)
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
