package store

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// RetiredMessage is what remains of a message `bank retire` deleted: enough to
// say what a citation pointed at, and which record replaced it.
type RetiredMessage struct {
	Ref         string    `json:"ref"`
	Source      string    `json:"source"`
	ExternalID  string    `json:"external_id"`
	SentAt      time.Time `json:"sent_at"`
	Subject     string    `json:"subject,omitempty"`
	RawRef      string    `json:"raw_ref,omitempty"`
	Reason      string    `json:"reason,omitempty"`
	Replacement string    `json:"replacement,omitempty"`
	RetiredAt   time.Time `json:"retired_at"`
}

// RetiredError answers a ref lookup whose message was retired. It matches
// ErrNotFound, because no message row exists, so callers that only ask
// "is it there" keep working; callers that can show more unwrap it.
type RetiredError struct {
	Retired RetiredMessage `json:"retired"`
}

func (e *RetiredError) Error() string {
	return fmt.Sprintf("message %s was retired", e.Retired.Ref)
}

func (e *RetiredError) Is(target error) bool { return target == ErrNotFound }

type RetireOptions struct {
	Source           string
	ExternalPrefixes []string
	// Replacements maps a retiring message's ref to the library record that
	// now holds what it said.
	Replacements map[string]string
	Reason       string
	Apply        bool
}

type RetirePrefix struct {
	Prefix      string           `json:"prefix"`
	Messages    int64            `json:"messages"`
	Attachments int64            `json:"attachments"`
	Samples     []RetiredMessage `json:"samples"`
}

type RetireResult struct {
	Source   string         `json:"source"`
	Prefixes []RetirePrefix `json:"prefixes"`
	Messages int64          `json:"messages"`
	// Replaced counts retiring messages the replacement map covers;
	// UnmatchedReplacements are map refs that name no retiring message.
	Replaced              int      `json:"replaced"`
	UnmatchedReplacements []string `json:"unmatched_replacements"`
	Applied               bool     `json:"applied"`
	Retired               int64    `json:"retired"`
}

const retireSamples = 3

func (o RetireOptions) validate() error {
	if strings.TrimSpace(o.Source) == "" {
		return fmt.Errorf("retire needs a source")
	}
	if len(o.ExternalPrefixes) == 0 {
		return fmt.Errorf("retire needs at least one external id prefix")
	}
	for i, p := range o.ExternalPrefixes {
		if p == "" {
			return fmt.Errorf("an empty prefix would retire the whole source")
		}
		for j, q := range o.ExternalPrefixes {
			if i != j && strings.HasPrefix(q, p) {
				return fmt.Errorf("prefix %q overlaps %q", p, q)
			}
		}
	}
	for ref, id := range o.Replacements {
		if err := ValidRef(ref); err != nil {
			return err
		}
		if id == "" {
			return fmt.Errorf("replacement for %s is empty", ref)
		}
	}
	return nil
}

const retiringPredicate = `m.source = $1 and exists (select 1 from unnest($2::text[]) p where starts_with(m.external_id, p))`

// RetireMessages reports, and with Apply deletes, the messages of one source
// whose external id starts with one of the prefixes. Each deleted row leaves a
// tombstone in the same statement, so no row can go without one; dependent
// attachment, mailbox and mail-thread rows go with it through their cascades.
// Blobs and raw archive files stay: they may be shared, and they are the
// evidence the tombstone points back at.
func (s *Store) RetireMessages(ctx context.Context, o RetireOptions) (RetireResult, error) {
	res := RetireResult{Source: o.Source, Prefixes: []RetirePrefix{}, UnmatchedReplacements: []string{}}
	if err := o.validate(); err != nil {
		return res, err
	}
	refs := slices.Sorted(maps.Keys(o.Replacements))
	ids := make([]string, len(refs))
	for i, ref := range refs {
		ids[i] = o.Replacements[ref]
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	rows, _ := tx.Query(ctx, `
		select distinct wanted.id from unnest($1::text[]) as wanted(id)
		where not exists (select 1 from library_items i where i.id = wanted.id)
		  and not exists (select 1 from library_activity a where a.id = wanted.id)
		  and not exists (select 1 from library_collections c where c.id = wanted.id)
		order by wanted.id`, ids)
	missing, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return res, err
	}
	if len(missing) > 0 {
		return res, fmt.Errorf("replacement ids not in the library: %s", strings.Join(missing, ", "))
	}

	rows, err = tx.Query(ctx, `
		select p, count(m.id),
		       coalesce((select count(*) from attachments a join messages am on am.id = a.message_id
		                 where am.source = $1 and starts_with(am.external_id, p)), 0)
		from unnest($2::text[]) with ordinality as prefixes(p, n)
		left join messages m on m.source = $1 and starts_with(m.external_id, p)
		group by p, n order by n`, o.Source, o.ExternalPrefixes)
	if err != nil {
		return res, err
	}
	for rows.Next() {
		var p RetirePrefix
		if err := rows.Scan(&p.Prefix, &p.Messages, &p.Attachments); err != nil {
			rows.Close()
			return res, err
		}
		p.Samples = []RetiredMessage{}
		res.Messages += p.Messages
		res.Prefixes = append(res.Prefixes, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return res, err
	}

	for i := range res.Prefixes {
		rows, _ := tx.Query(ctx, `
			select `+refSQL("m")+`, m.source, m.external_id, m.sent_at, m.subject, m.raw_ref
			from messages m where m.source = $1 and starts_with(m.external_id, $2)
			order by m.sent_at, m.id limit $3`, o.Source, res.Prefixes[i].Prefix, retireSamples)
		samples, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (RetiredMessage, error) {
			var r RetiredMessage
			err := row.Scan(&r.Ref, &r.Source, &r.ExternalID, &r.SentAt, &r.Subject, &r.RawRef)
			r.Replacement = o.Replacements[r.Ref]
			return r, err
		})
		if err != nil {
			return res, err
		}
		res.Prefixes[i].Samples = samples
	}

	rows, _ = tx.Query(ctx, `
		select m.ref from (select `+refSQL("m")+` as ref from messages m where `+retiringPredicate+`) m
		where m.ref = any($3)`, o.Source, o.ExternalPrefixes, refs)
	matched, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return res, err
	}
	res.Replaced = len(matched)
	for _, ref := range refs {
		if !slices.Contains(matched, ref) {
			res.UnmatchedReplacements = append(res.UnmatchedReplacements, ref)
		}
	}

	if !o.Apply {
		return res, nil
	}
	if len(res.UnmatchedReplacements) > 0 {
		return res, fmt.Errorf("replacement map refs match no retiring message: %s", strings.Join(res.UnmatchedReplacements, ", "))
	}
	tag, err := tx.Exec(ctx, `
		with gone as (
			delete from messages m where `+retiringPredicate+`
			returning m.source, m.external_id, `+refSQL("m")+` as ref, m.sent_at, m.subject, m.raw_ref
		)
		insert into message_tombstones (source, external_id, ref, sent_at, subject, raw_ref, reason, replacement)
		select g.source, g.external_id, g.ref, g.sent_at, g.subject, g.raw_ref, $3, coalesce(r.id, '')
		from gone g left join unnest($4::text[], $5::text[]) as r(ref, id) on r.ref = g.ref
		on conflict (source, external_id) do nothing`,
		o.Source, o.ExternalPrefixes, cleanText(o.Reason), refs, ids)
	if err != nil {
		return res, err
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	res.Applied, res.Retired = true, tag.RowsAffected()
	return res, nil
}

// RetiredByRef is the tombstone a ref lookup falls back to.
func (s *Store) RetiredByRef(ctx context.Context, ref string) (RetiredMessage, error) {
	var r RetiredMessage
	err := s.pool.QueryRow(ctx, `
		select ref, source, external_id, sent_at, subject, raw_ref, reason, replacement, retired_at
		from message_tombstones where ref = $1 order by retired_at, source, external_id limit 1`, ref).
		Scan(&r.Ref, &r.Source, &r.ExternalID, &r.SentAt, &r.Subject, &r.RawRef, &r.Reason, &r.Replacement, &r.RetiredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, ErrNotFound
	}
	return r, err
}
