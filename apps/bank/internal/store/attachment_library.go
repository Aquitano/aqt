package store

import (
	"context"
	"errors"
	"fmt"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type AttachmentFilter struct {
	Query, Source, Match             string
	Filename, Text, FileType, Person string
	Since, Until                     time.Time
	Limit, Offset                    int
}

type LibraryFile struct {
	SHA256    string    `json:"sha256"`
	Filename  string    `json:"filename"`
	MimeType  string    `json:"mime_type"`
	SizeBytes int64     `json:"size_bytes"`
	Messages  int       `json:"messages"`
	LastAt    time.Time `json:"last_at"`
	Snippet   string    `json:"snippet,omitempty"`
}

func (s *Store) AttachmentLibrary(ctx context.Context, o AttachmentFilter) ([]LibraryFile, error) {
	if err := (library.ListOptions{Query: o.Query, Match: o.Match, Limit: o.Limit, Offset: o.Offset}).Validate(); err != nil {
		return nil, err
	}
	if o.Limit == 0 {
		o.Limit = 50
	}
	if o.Offset < 0 || o.Offset > MaxSearchOffset {
		return nil, fmt.Errorf("invalid offset")
	}
	where := "true"
	ctes := ""
	queryParameter := ""
	args := []any{}
	arg := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	if o.Source != "" {
		where += " and m.source=" + arg(o.Source)
	}
	if o.Query != "" {
		queryParameter = arg(o.Query)
	}
	if o.Filename != "" {
		where += " and strpos(lower(a.filename), lower(" + arg(o.Filename) + "))>0"
	}
	snippet := "''"
	if o.Text != "" {
		p := arg(o.Text)
		where += " and exists (select 1 from blob_text b where b.sha256=a.sha256 and b.status in ('ok','manual') and strpos(lower(b.text),lower(" + p + "))>0)"
		snippet = "(select substring(b.text from greatest(1,strpos(lower(b.text),lower(" + p + "))-80) for 240) from blob_text b where b.sha256=matched.sha256)"
	}
	if o.FileType != "" {
		typ := strings.ToLower(strings.TrimPrefix(o.FileType, "."))
		p := arg(typ)
		where += " and (lower(a.mime_type)=" + p + " or split_part(lower(a.mime_type),'/',1)=" + p + " or right(lower(a.filename),length(" + p + ")+1) = '.' || " + p + ")"
	}
	if o.Person != "" {
		c, err := s.GetContact(ctx, o.Person)
		if errors.Is(err, ErrNotFound) {
			return nil, &ErrNoContact{Name: o.Person}
		}
		if err != nil {
			return nil, err
		}
		where += " and " + aliasMatch(arg(c.ID))
	}
	if !o.Since.IsZero() {
		where += " and m.sent_at>=" + arg(o.Since)
	}
	if !o.Until.IsZero() {
		where += " and m.sent_at<" + arg(o.Until)
	}
	if queryParameter != "" {
		metadataVector := "to_tsvector('simple',n.filename || ' ' || regexp_replace(n.filename,'[._-]+',' ','g'))"
		ctes = `attachment_names as materialized (
 select distinct a.sha256,a.filename from attachments a join messages m on m.id=a.message_id where ` + where + `
 ), ` + libraryTextMatches(queryParameter, "select distinct sha256 from attachment_names") + `, matching_names as materialized (
 select n.sha256,n.filename from attachment_names n left join text_matches b on b.sha256=n.sha256
 where (` + metadataVector + ` || coalesce(b.search_vector,''::tsvector)) @@ ` + libraryTextQuery(o.Match, queryParameter) + `
 ), `
		where += " and exists(select 1 from matching_names n where n.sha256=a.sha256 and n.filename=a.filename)"
	}
	rows, err := s.pool.Query(ctx, `with `+ctes+`matched as (
 select a.sha256,min(a.filename) filename,min(a.mime_type) mime_type,max(a.size_bytes) size_bytes,max(m.sent_at) last_at
 from attachments a join messages m on m.id=a.message_id where `+where+` group by a.sha256
 ) select sha256,filename,mime_type,size_bytes,
 (select count(distinct message_id) from attachments a where a.sha256=matched.sha256),last_at,`+snippet+`
 from matched order by last_at desc,sha256 limit `+arg(o.Limit)+` offset `+arg(o.Offset), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []LibraryFile{}
	for rows.Next() {
		var a LibraryFile
		if err := rows.Scan(&a.SHA256, &a.Filename, &a.MimeType, &a.SizeBytes, &a.Messages, &a.LastAt, &a.Snippet); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) AttachmentMessages(ctx context.Context, sum string, offset, limit int) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 || offset > MaxSearchOffset {
		return nil, fmt.Errorf("invalid offset")
	}
	rows, err := s.pool.Query(ctx, `select `+messageColumns+` from messages m where exists
 (select 1 from attachments a where a.message_id=m.id and a.sha256=$1)
 order by m.sent_at desc,m.id desc limit $2 offset $3`, sum, limit, offset)
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

func (s *Store) MessageParent(ctx context.Context, id int64) (Message, error) {
	var m Message
	err := m.scanFull(s.pool.QueryRow(ctx, `select `+messageColumns+` from messages m join messages child
 on m.source=child.source and m.thread_id=child.thread_id and m.external_id=child.parent_external_id
 where child.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrNotFound
	}
	return m, err
}
