package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// MaxSearchLimit caps how many rows one search may return. Large enough for
// "give me everything about X", small enough that a typo can't ask Postgres
// for the whole archive.
const MaxSearchLimit = 500

// MaxFuzzyDistance is pg_search's supported Levenshtein range.
const MaxFuzzyDistance = 2

// MaxSearchOffset bounds how deep paging may go. Every offset re-ranks the
// whole match set before discarding the skipped rows, so page 500 costs what
// page 1 cost plus everything between. Twenty pages of 500 is far past the
// point where narrowing the query beats paging through it.
const MaxSearchOffset = 10000

type SearchOpts struct {
	MailboxID     int64
	Subject       string
	HasAttachment *bool
	Match         string // any (default), all, or phrase
	Source        string
	From          string
	To            string
	// Person is a contact name: the filter resolves through that contact's
	// aliases, so one query covers every source the person appears in.
	Person string
	Since  time.Time
	Until  time.Time
	Fuzzy  int
	Limit  int
	// Offset skips this many ranked results, so a query with more matches
	// than Limit is reachable past the first page.
	Offset int
}

// Validate rejects options that would otherwise return misleading empty
// results or a raw database error. Both the CLI and the HTTP handler call it,
// so local and remote modes fail the same way.
func (o SearchOpts) Validate() error {
	if o.MailboxID < 0 || (o.MailboxID != 0 && o.Source == "") {
		return fmt.Errorf("mailbox_id must be positive and requires a source")
	}
	switch o.Match {
	case "", "any", "all", "phrase":
	default:
		return fmt.Errorf("match must be any, all, or phrase")
	}
	if o.Limit <= 0 {
		return fmt.Errorf("limit must be at least 1")
	}
	if o.Limit > MaxSearchLimit {
		return fmt.Errorf("limit must be at most %d", MaxSearchLimit)
	}
	if o.Fuzzy < 0 || o.Fuzzy > MaxFuzzyDistance {
		return fmt.Errorf("fuzzy must be between 0 and %d", MaxFuzzyDistance)
	}
	if o.Offset < 0 {
		return fmt.Errorf("offset must not be negative")
	}
	if o.Offset > MaxSearchOffset {
		return fmt.Errorf("offset must be at most %d; narrow the query instead of paging deeper", MaxSearchOffset)
	}
	if !o.Since.IsZero() && !o.Until.IsZero() && !o.Until.After(o.Since) {
		return fmt.Errorf("--until must be after --since")
	}
	return nil
}

func (o SearchOpts) ValidateQuery(query string) error {
	if err := o.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(query) == "" {
		return fmt.Errorf("search query must not be empty")
	}
	if o.Match == "all" && len(strings.Fields(query)) > 32 {
		return fmt.Errorf("all-words search supports at most 32 terms")
	}
	return nil
}

// Search runs a BM25-ranked query over subject, body, sender and recipients
// via pg_search. Fuzzy is the Levenshtein distance for typo tolerance
// (0 = exact tokens).
func (s *Store) Search(ctx context.Context, query string, o SearchOpts) ([]Message, error) {
	if err := o.ValidateQuery(query); err != nil {
		return nil, err
	}
	query = strings.TrimSpace(query)
	if err := s.validateMailbox(ctx, o.Source, o.MailboxID); err != nil {
		return nil, err
	}
	args := []any{query}
	if o.Match != "phrase" {
		args = append(args, o.Fuzzy)
	}
	next := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	predicate := searchFields("$1", o.Match == "phrase", false)
	if o.Match == "all" {
		terms := strings.Fields(query)
		var required []string
		for _, term := range terms {
			required = append(required, searchFields(next(term), false, true))
		}
		predicate = "paradedb.boolean(must => array[" + strings.Join(required, ",") + "], should => array[" + predicate + "])"
	}
	sql := fmt.Sprintf(`select m.id, `+refSQL("m")+`, m.source, m.thread_id, m.sender, m.subject, m.body, m.sent_at,
		paradedb.score(m.id), coalesce(paradedb.snippet(m.body, '', '', %d), ''),
		coalesce(paradedb.snippet(m.attachment_text, '', '', %d), '')
		from messages m where m.id @@@ `+predicate, snippetChars, snippetChars)
	if o.Source != "" {
		sql += " and m.source = " + next(o.Source)
	}
	sql += mailPredicates(o.MailboxID, o.Subject, o.HasAttachment, next)
	if o.From != "" {
		sql += " and m.sender ilike " + next("%"+o.From+"%")
	}
	if o.To != "" {
		sql += " and exists (select 1 from unnest(m.recipients) r where r ilike " + next("%"+o.To+"%") + ")"
	}
	if o.Person != "" {
		c, err := s.GetContact(ctx, o.Person)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return nil, &ErrNoContact{Name: o.Person}
			}
			return nil, err
		}
		sql += " and" + aliasMatch(next(c.ID))
	}
	if !o.Since.IsZero() {
		sql += " and m.sent_at >= " + next(o.Since)
	}
	if !o.Until.IsZero() {
		sql += " and m.sent_at < " + next(o.Until)
	}
	// m.id breaks the remaining ties. Score ties are ordinary — two messages
	// matching the same words the same way — and two messages can share a
	// sent_at to the second, so without it the sort is only a partial order:
	// the same query can return the same rows in a different arrangement, and
	// paging would then duplicate some and skip others.
	sql += " order by paradedb.score(m.id) desc, m.sent_at desc, m.id desc limit " + next(o.Limit)
	if o.Offset > 0 {
		sql += " offset " + next(o.Offset)
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Ref, &m.Source, &m.ThreadID, &m.Sender, &m.Subject, &m.Body,
			&m.SentAt, &m.Score, &m.Snippet, &m.AttachmentSnippet); err != nil {
			return nil, err
		}
		m.Snippet = Snippet(m.Snippet, m.Body, query)
		m.AttachmentSnippet = Snippet(m.AttachmentSnippet, "", query)
		out = append(out, m)
	}
	return out, rows.Err()
}

// Exact matches contribute more than fuzzy matches; subject matches carry
// extra weight. Keep field selection identical across all query modes.
func searchFields(value string, phrase, conjunction bool) string {
	var queries []string
	for _, field := range []string{"subject", "body", "sender", "recipients", "attachment_text"} {
		weight := 1
		if field == "subject" {
			weight = 3
		}
		if phrase {
			queries = append(queries, fmt.Sprintf("paradedb.boost(%d, paradedb.phrase('%s', %s))", weight, field, value))
			continue
		}
		queries = append(queries,
			fmt.Sprintf("paradedb.boost(%d, paradedb.match('%s', %s, distance => $2, conjunction_mode => %t))", weight, field, value, conjunction),
			fmt.Sprintf("paradedb.boost(%d, paradedb.match('%s', %s, distance => 0, conjunction_mode => %t))", weight*2, field, value, conjunction))
	}
	return "paradedb.boolean(should => array[" + strings.Join(queries, ",") + "])"
}
