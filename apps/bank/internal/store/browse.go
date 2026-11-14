package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

type BrowseOpts struct {
	Source, Order string
	Limit         int
	// After is the LastRef of the previous page's last thread; the page
	// continues after it in the chosen order.
	After                     ref.Message
	MailboxID                 int64
	Subject, From, To, Person string
	HasAttachment             *bool
	Since, Until              time.Time
}

func (o BrowseOpts) Validate() error {
	if err := page.Check(o.Limit, 0); err != nil {
		return err
	}
	if o.MailboxID < 0 || (o.MailboxID != 0 && o.Source == "") {
		return fail.Invalidf("mailbox_id must be positive and requires a source")
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Until.After(o.Since) {
		return fail.Invalidf("--until must be after --since")
	}
	if o.Order != "" && o.Order != "asc" && o.Order != "desc" {
		return fail.Invalidf("order must be asc or desc")
	}
	return nil
}

type ThreadGroup struct {
	Source   string `json:"source"`
	ThreadID string `json:"thread_id"`
	Count    int64  `json:"n"`
	// LastAt is absent when no message in the thread has a date.
	LastAt  time.Time `json:"last_at,omitzero"`
	LastRef string    `json:"last_ref"`
	Sender  string    `json:"sender"`
	Subject string    `json:"subject"`
	Preview string    `json:"preview"`
	Members string    `json:"members"`
}

// BrowseThreads lists conversations by their latest message that passes the
// filters. It walks matching messages in (sort_at, id) order on
// messages_sort_idx and keeps a message only when no newer matching message
// shares its thread, which messages_source_thread_page_idx answers, so a
// page reads the messages up to its last thread and no further. Counts,
// subjects and members are then read for that page's threads only. Members
// are the first 30 senders by name, enough for the 200 characters shown,
// because telling the owner apart costs a function call per sender. A message
// without a thread id is a thread of its own.
func (s *Store) BrowseThreads(ctx context.Context, o BrowseOpts) ([]ThreadGroup, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	if err := s.validateMailbox(ctx, o.Source, o.MailboxID); err != nil {
		return nil, err
	}
	var a args
	var self []string
	if err := s.pool.QueryRow(ctx, `select array(select case when a.source = '' then a.value_norm else a.source || chr(31) || a.value_norm end
		from contact_aliases a join contacts c on c.id = a.contact_id where c.self)`).Scan(&self); err != nil {
		return nil, err
	}
	var person []string
	if o.Person != "" {
		var err error
		if person, err = s.ContactKeys(ctx, o.Person); err != nil {
			return nil, err
		}
	}
	// filters is evaluated for the walked message m and again for the
	// messages n of its thread, so the parameters are bound once per alias.
	filters := func(m string) string {
		where := mailPredicates(m, o.MailboxID, o.Subject, o.HasAttachment, a.next)
		if o.Source != "" {
			where += " and " + m + ".source = " + a.next(o.Source)
		}
		if o.From != "" {
			where += " and " + m + ".sender ilike " + a.next("%"+o.From+"%")
		}
		if o.To != "" {
			where += " and exists(select 1 from unnest(" + m + ".recipients) recipient where recipient ilike " + a.next("%"+o.To+"%") + ")"
		}
		if !o.Since.IsZero() {
			where += " and " + m + ".sent_at >= " + a.next(o.Since)
		}
		if !o.Until.IsZero() {
			where += " and " + m + ".sent_at < " + a.next(o.Until)
		}
		if o.Person != "" {
			where += " and " + m + ".participants && " + a.next(person) + "::text[]"
		}
		return where
	}
	order, newer, older := "desc", ">", "<"
	if o.Order == "asc" {
		order, newer, older = "asc", "<", ">"
	}
	walk := "true" + filters("m")
	sameThread := "n.source = m.source and n.thread_id = m.thread_id"
	walk += " and (m.thread_id = '' or not exists (select 1 from messages n where " + sameThread +
		" and (n.sort_at, n.id) " + newer + " (m.sort_at, m.id)" + filters("n") + "))"
	if !o.After.IsZero() {
		var sortAt time.Time
		var id int64
		err := s.pool.QueryRow(ctx, `select sort_at, id from messages where ref = $1`, o.After.String()).Scan(&sortAt, &id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fail.Invalidf("after is not a message ref")
		}
		if err != nil {
			return nil, err
		}
		walk += " and (m.sort_at, m.id) " + older + " (" + a.next(sortAt) + "::timestamptz, " + a.next(id) + "::bigint)"
	}
	thread := "(m.thread_id = '' and n.id = m.id or m.thread_id <> '' and " + sameThread + ")"
	details := filters("n")
	selfKeys := a.next(nonNil(self))
	rows, err := s.pool.Query(ctx, `select m.source, m.thread_id, d.n, m.sent_at, m.ref, m.sender, coalesce(d.subject, ''),
			left(m.body, 240), coalesce(d.members, '')
		from (select * from messages m where `+walk+`
			order by m.sort_at `+order+`, m.id `+order+` limit `+a.next(o.Limit)+`) m
		cross join lateral (select
			(select count(*) from messages n where `+thread+details+`) as n,
			(select n.subject from messages n where `+thread+details+` and n.subject <> ''
				order by n.sort_at desc, n.id desc limit 1) as subject,
			(select left(string_agg(s.sender, ', ' order by s.sender), 200)
				from (select distinct n.source, n.sender from messages n where `+thread+details+` and n.sender <> ''
					order by n.sender limit 30) s
				where not bank_participants(s.source, s.sender, '{}') && `+selfKeys+`::text[]) as members
		) d
		order by m.sort_at `+order+`, m.id `+order, a...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ThreadGroup{}
	for rows.Next() {
		var g ThreadGroup
		if err := rows.Scan(&g.Source, &g.ThreadID, &g.Count, optionalTime{&g.LastAt}, &g.LastRef, &g.Sender, &g.Subject, &g.Preview, &g.Members); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
