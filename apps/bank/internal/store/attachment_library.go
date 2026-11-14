package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/page"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/jackc/pgx/v5"
)

type AttachmentFilter struct {
	Query, Source, Match             string
	Exact                            bool
	Filename, Text, FileType, Person string
	Since, Until                     time.Time
	Limit, Offset                    int
}

type LibraryFile struct {
	BLAKE3    content.Digest `json:"blake3"`
	Filename  string         `json:"filename"`
	MimeType  string         `json:"mime_type"`
	SizeBytes int64          `json:"size_bytes"`
	Messages  int            `json:"messages"`
	// LastAt is absent when none of the messages holding it has a date.
	LastAt  time.Time `json:"last_at,omitzero"`
	Snippet string    `json:"snippet,omitempty"`
}

func (s *Store) AttachmentLibrary(ctx context.Context, o AttachmentFilter) ([]LibraryFile, error) {
	o.Limit = page.Limit(o.Limit)
	if err := page.Check(o.Limit, o.Offset); err != nil {
		return nil, err
	}
	var keys []string
	if o.Person != "" {
		var err error
		if keys, err = s.ContactKeys(ctx, o.Person); err != nil {
			return nil, err
		}
	}
	// filter is every filter but the query, over the attachment a and its
	// message m.
	filter := func(a *args) string {
		where := ""
		if o.Source != "" {
			where += " and m.source=" + a.next(o.Source)
		}
		if o.Filename != "" {
			where += " and strpos(lower(a.filename), lower(" + a.next(o.Filename) + "))>0"
		}
		if o.Text != "" {
			where += " and exists (select 1 from texts b where b.content_id=a.content_id and b.status in ('ok','truncated','manual') and strpos(lower(b.text),lower(" + a.next(o.Text) + "))>0)"
		}
		if o.FileType != "" {
			p := a.next(strings.ToLower(strings.TrimPrefix(o.FileType, ".")))
			where += " and (lower(a.mime_type)=" + p + " or split_part(lower(a.mime_type),'/',1)=" + p + " or right(lower(a.filename),length(" + p + ")+1) = '.' || " + p + ")"
		}
		if o.Person != "" {
			where += " and m.participants && " + a.next(keys) + "::text[]"
		}
		if !o.Since.IsZero() {
			where += " and m.sent_at>=" + a.next(o.Since)
		}
		if !o.Until.IsZero() {
			where += " and m.sent_at<" + a.next(o.Until)
		}
		return where
	}
	var a args
	where := "true" + filter(&a)
	snippet := "''"
	if o.Text != "" {
		p := a.next(o.Text)
		snippet = "(select substring(b.text from greatest(1,strpos(lower(b.text),lower(" + p + "))-80) for 240) from texts b where b.content_id=matched.content_id)"
	}
	order, window := "matched.sort_at desc,c.blake3", ""
	if o.Query == "" {
		window = " limit " + a.next(o.Limit) + " offset " + a.next(o.Offset)
	} else {
		ids, err := s.rankAttachments(ctx, o, filter)
		if err != nil {
			return nil, err
		}
		p := a.next(ids)
		where += " and a.content_id = any(" + p + "::bigint[])"
		order = "array_position(" + p + "::bigint[], matched.content_id)"
	}
	rows, err := s.pool.Query(ctx, `with matched as (
 select a.content_id,min(a.filename) filename,min(a.mime_type) mime_type,max(m.sent_at) last_at,max(m.sort_at) sort_at
 from attachments a join messages m on m.id=a.message_id where `+where+` group by a.content_id
 ) select c.blake3,matched.filename,matched.mime_type,c.size_bytes,
 (select count(distinct message_id) from attachments a where a.content_id=matched.content_id),last_at,`+snippet+`
 from matched join contents c on c.id=matched.content_id order by `+order+window, a...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LibraryFile{}
	for rows.Next() {
		var a LibraryFile
		if err := rows.Scan(&a.BLAKE3, &a.Filename, &a.MimeType, &a.SizeBytes, &a.Messages, optionalTime{&a.LastAt}, &a.Snippet); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// rankAttachments ranks attachment contents by filename and by the text read
// from them, among the attachments filter admits, and returns the page o asks
// for as content ids.
func (s *Store) rankAttachments(ctx context.Context, o AttachmentFilter, filter func(*args) string) ([]int64, error) {
	q, err := search.Parse(o.Query, search.Mode(o.Match))
	if err != nil {
		return nil, err
	}
	q.Exact = o.Exact
	n := o.Offset + o.Limit
	hits, _, err := search.Rank(q, o.Offset, o.Limit, func(q search.Query) ([]search.List, error) {
		names, err := s.searchAttachmentNames(ctx, q, n, func(a *args) string {
			return " and exists (select 1 from messages m where m.id = a.message_id" + filter(a) + ")"
		})
		if err != nil {
			return nil, err
		}
		texts, err := s.searchTexts(ctx, q, search.Filters{}, n, func(a *args) string {
			return " and exists (select 1 from attachments a join messages m on m.id = a.message_id where a.content_id = t.content_id" + filter(a) + ")"
		})
		return []search.List{names, texts}, err
	})
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(hits))
	for i, h := range hits {
		ids[i] = h.ContentID
	}
	return ids, nil
}

func (s *Store) AttachmentMessages(ctx context.Context, d content.Digest, offset, limit int) ([]Message, error) {
	limit = page.Limit(limit)
	if err := page.Check(limit, offset); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select `+messageColumns+` from messages m where exists
 (select 1 from attachments a join contents c on c.id=a.content_id where a.message_id=m.id and c.blake3=$1)
 order by m.sort_at desc,m.id desc limit $2 offset $3`, d, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := m.scanFull(rows); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) MessageParent(ctx context.Context, child ref.Message) (Message, error) {
	var m Message
	err := m.scanFull(s.pool.QueryRow(ctx, `select `+messageColumns+` from messages m join messages child
 on m.source=child.source and m.thread_id=child.thread_id and m.external_id=child.parent_external_id
 where child.ref=$1`, child.String()))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}
