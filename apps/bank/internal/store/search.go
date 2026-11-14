package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/search"
)

// args collects a statement's values and names their placeholders.
type args []any

func (a *args) next(v any) string {
	*a = append(*a, v)
	return "$" + strconv.Itoa(len(*a))
}

func must(clauses []string) string {
	if len(clauses) == 1 {
		return clauses[0]
	}
	return "paradedb.boolean(must => array[" + strings.Join(clauses, ", ") + "])"
}

var (
	messageFields = []search.Field{{Name: "subject", Boost: 3}, {Name: "body"}, {Name: "sender"}, {Name: "recipients"}}
	textFields    = []search.Field{{Name: "text"}}
	filenameField = []search.Field{{Name: "filename", Boost: 3}, {Name: "filename_ngram", Fragment: true}}
)

// messageFilters turns f into clauses a messages BM25 query must also match
// and predicates over m, each starting with " and ". Source, thread and dates
// stay predicates: pg_search applies them inside its scan because the index
// holds those fields. Participants, sender and recipients are clauses,
// because pg_search leaves an array overlap or a pattern match to the heap.
func messageFilters(f search.Filters, a *args) (clauses []string, where string) {
	if f.Source != "" {
		where += " and m.source = " + a.next(f.Source)
	}
	if f.Thread != "" {
		where += " and m.thread_id = " + a.next(f.Thread)
	}
	if !f.Since.IsZero() {
		where += " and m.sent_at >= " + a.next(f.Since)
	}
	if !f.Until.IsZero() {
		where += " and m.sent_at < " + a.next(f.Until)
	}
	if f.Person != "" {
		clauses = append(clauses, "paradedb.term_set('participants', "+a.next(nonNil(f.Participants))+"::text[])")
	}
	if f.From != "" {
		clauses = append(clauses, "paradedb.match('sender', "+a.next(f.From)+", conjunction_mode => true)")
	}
	if f.To != "" {
		clauses = append(clauses, "paradedb.match('recipients', "+a.next(f.To)+", conjunction_mode => true)")
	}
	where += mailPredicates("m", f.MailboxID, f.Subject, f.HasAttachment, a.next)
	return clauses, where
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ranked runs a list's page and its match count as one round trip.
func (s *Store) ranked(ctx context.Context, page, count string, a args, scan func(pgx.CollectableRow) (search.SearchHit, error)) ([]search.SearchHit, int64, error) {
	batch := &pgx.Batch{}
	batch.Queue(page, a...)
	batch.Queue(count, a...)
	results := s.pool.SendBatch(ctx, batch)
	defer results.Close()
	rows, err := results.Query()
	if err != nil {
		return nil, 0, err
	}
	hits, err := pgx.CollectRows(rows, scan)
	if err != nil {
		return nil, 0, err
	}
	var n int64
	err = results.QueryRow().Scan(&n)
	return hits, n, err
}

// SearchMessages ranks messages by their subject, body, sender and
// recipients: score, then newest, then id, so a page means the same thing
// twice. It returns n hits.
func (s *Store) SearchMessages(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error) {
	list := search.List{Name: "messages", Kind: search.KindMessage}
	if err := s.validateMailbox(ctx, f.Source, f.MailboxID); err != nil {
		return list, err
	}
	var a args
	clauses, where := messageFilters(f, &a)
	cond := "m.id @@@ " + must(append([]string{q.Clause(messageFields, a.next)}, clauses...)) + where
	words := strings.Join(q.Words(), " ")
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx,
		`select m.ref, m.source, m.thread_id, m.subject, m.sent_at,
			coalesce(paradedb.snippet(m.body, '', '', `+strconv.Itoa(snippetChars)+`), ''), left(m.body, 4000)
		from messages m where `+cond+`
		order by paradedb.score(m.id) desc, m.sort_at desc, m.id desc limit `+strconv.Itoa(n),
		`select count(*) from messages m where `+cond, a,
		func(row pgx.CollectableRow) (search.SearchHit, error) {
			h := search.SearchHit{Kind: search.KindMessage}
			var sent *time.Time
			var engine, body string
			err := row.Scan(&h.Ref, &h.Source, &h.ThreadID, &h.Title, &sent, &engine, &body)
			h.Key, h.At = h.Ref, sent
			h.Snippet = Snippet(engine, body, words)
			if h.Title == "" {
				h.Title, _ = headRunes(collapse(body), 100)
			}
			return h, err
		})
	return list, err
}

// owners restricts a content to those held by an owner f admits: a message
// that passes the message filters or a library file of the source and
// account. Without such filters every content passes. The owners' contents
// are collected first and compared with the index's key, which pg_search
// applies inside its top-N scan; as an EXISTS per match it scored and
// snippeted every match before filtering them.
func owners(contentID string, f search.Filters, a *args) string {
	if f.Source == "" && f.Account == "" && !f.Dated() && !f.MessageScoped() {
		return ""
	}
	var held []string
	if f.Account == "" {
		clauses, where := messageFilters(f, a)
		if len(clauses) > 0 {
			where = " and m.id @@@ " + must(clauses) + where
		}
		held = append(held, "select a.content_id from attachments a join messages m on m.id = a.message_id where true"+where)
	}
	if !f.Dated() && !f.MessageScoped() {
		where := ""
		if f.Source != "" {
			where += " and lf.source = " + a.next(f.Source)
		}
		if f.Account != "" {
			where += " and lf.account = " + a.next(f.Account)
		}
		held = append(held, "select lf.content_id from library_files lf where true"+where)
	}
	if len(held) == 0 {
		return " and false"
	}
	return " and " + contentID + " = any(array(" + strings.Join(held, " union ") + "))"
}

func scanContent(row pgx.CollectableRow) (search.SearchHit, error) {
	h := search.SearchHit{Kind: search.KindFile}
	var snippet string
	err := row.Scan(&h.ContentID, &h.Title, &snippet)
	h.Key = search.ContentKey(h.ContentID)
	h.Snippet = Snippet(snippet, "", "")
	return h, err
}

// SearchTexts ranks contents by the text read from them, which is indexed
// once per content whichever messages, library files and disks hold it.
func (s *Store) SearchTexts(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error) {
	return s.searchTexts(ctx, q, f, n, nil)
}

// searchTexts takes held, when it is set, to restrict the contents instead of
// the owners f admits.
func (s *Store) searchTexts(ctx context.Context, q search.Query, f search.Filters, n int, held func(*args) string) (search.List, error) {
	list := search.List{Name: "text", Kind: search.KindFile}
	var a args
	cond := "t.content_id @@@ " + q.Clause(textFields, a.next) + " and t.status in ('ok', 'truncated', 'manual')"
	if held != nil {
		cond += held(&a)
	} else {
		cond += owners("t.content_id", f, &a)
	}
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx,
		`select t.content_id, '', coalesce(paradedb.snippet(t.text, '', '', `+strconv.Itoa(snippetChars)+`), '')
		from texts t where `+cond+` order by paradedb.score(t.content_id) desc, t.content_id limit `+strconv.Itoa(n),
		`select count(*) from texts t where `+cond, a, scanContent)
	return list, err
}

// SearchAttachmentNames ranks attachments by filename. A content attached to
// many messages comes once per attachment, and fusion keeps its best rank.
func (s *Store) SearchAttachmentNames(ctx context.Context, q search.Query, f search.Filters, n int) (search.List, error) {
	return s.searchAttachmentNames(ctx, q, n, func(a *args) string {
		if f.Source == "" && !f.Dated() && !f.MessageScoped() {
			return ""
		}
		clauses, where := messageFilters(f, a)
		if len(clauses) > 0 {
			where = " and m.id @@@ " + must(clauses) + where
		}
		return " and exists (select 1 from messages m where m.id = a.message_id" + where + ")"
	})
}

func (s *Store) searchAttachmentNames(ctx context.Context, q search.Query, n int, held func(*args) string) (search.List, error) {
	list := search.List{Name: "attachment name", Kind: search.KindFile}
	var a args
	cond := "a.content_id @@@ " + q.Clause(filenameField, a.next) + held(&a)
	var err error
	list.Hits, list.Matches, err = s.ranked(ctx,
		`select a.content_id, a.filename, '' from attachments a where `+cond+`
		order by paradedb.score(a.content_id) desc, a.content_id limit `+strconv.Itoa(n),
		`select count(*) from attachments a where `+cond, a, scanContent)
	return list, err
}

// ContentPlaces are where a content is in the archive, and its ref.
type ContentPlaces struct {
	Ref    string
	Digest string
	Places []search.FilePlace
	Count  int
}

// maxPlaces bounds the places listed per content; Count still counts all.
const maxPlaces = 20

// ContentPlaces lists the messages and library files that hold each content,
// newest message first.
func (s *Store) ContentPlaces(ctx context.Context, ids []int64) (map[int64]ContentPlaces, error) {
	out := map[int64]ContentPlaces{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `select id, 'content:' || encode(substr(blake3, 1, 8), 'hex'), encode(blake3, 'hex')
		from contents where id = any($1)`, ids)
	if err != nil {
		return nil, err
	}
	var id int64
	var c ContentPlaces
	if _, err := pgx.ForEachRow(rows, []any{&id, &c.Ref, &c.Digest}, func() error {
		out[id] = c
		return nil
	}); err != nil {
		return nil, err
	}
	rows, err = s.pool.Query(ctx, `select content_id, kind, ref, name, at, source, thread_id, total from (
		select p.*, row_number() over (partition by content_id order by o desc, n desc) as position,
			count(*) over (partition by content_id) as total
		from (
			select a.content_id, 'message' as kind, m.ref, a.filename as name, m.sent_at as at, m.source, m.thread_id,
				m.sort_at as o, m.id as n
			from attachments a join messages m on m.id = a.message_id where a.content_id = any($1)
			union all
			select f.content_id, 'library_file', f.id, f.filename, null, f.source, '', '-infinity', f.seq
			from library_files f where f.content_id = any($1)
		) p) p where position <= $2 order by content_id, position`, ids, maxPlaces)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var p search.FilePlace
		var total int
		if err := rows.Scan(&id, &p.Kind, &p.Ref, &p.Name, &p.At, &p.Source, &p.ThreadID, &total); err != nil {
			return nil, err
		}
		c := out[id]
		c.Places = append(c.Places, p)
		c.Count = total
		out[id] = c
	}
	return out, rows.Err()
}

// ContactKeys are the participant keys a contact's aliases match, for
// search.Filters.Participants.
func (s *Store) ContactKeys(ctx context.Context, name string) ([]string, error) {
	c, err := s.GetContact(ctx, name)
	if errors.Is(err, ErrNotFound) {
		return nil, &ErrNoContact{Name: name}
	}
	if err != nil {
		return nil, err
	}
	var keys []string
	err = s.pool.QueryRow(ctx, `select array(select case when a.source = '' then a.value_norm else a.source || chr(31) || a.value_norm end
		from contact_aliases a where a.contact_id = $1)`, c.ID).Scan(&keys)
	return nonNil(keys), err
}
