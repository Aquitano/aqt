package store

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/jobs"
	"github.com/aquitano/aqt/packages/go/extract"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

// StatusPending is the virtual status of a content no extraction has touched
// yet. It is not stored — the absence of a row is what it means — but naming
// it lets one filter cover "never tried" and "tried, retry it".
const StatusPending = "pending"

// MaxAttachmentTextChars bounds the denormalized per-message text. A message
// carrying a hundred scanned pages should still index, but a single row is
// not the place to keep a book.
//
// It is applied as bytes in Go and as characters in SQL (left() counts
// characters). Both bound the same thing from the same side — a byte count is
// never below the character count — so the Go side is the conservative one and
// the difference is not worth a second constant.
const MaxAttachmentTextChars = 4 << 20

// BlobText is the text read from one content, keyed by its digest.
type BlobText struct {
	BLAKE3      content.Digest `json:"blake3"`
	Text        string         `json:"text"`
	Extractor   string         `json:"extractor,omitempty"`
	Status      string         `json:"status"`
	Chars       int            `json:"chars"`
	ExtractedAt time.Time      `json:"extracted_at"`
}

// BlobRef is one distinct piece of attachment content and what is known about
// its text. Filename and MimeType come from an arbitrary message carrying it —
// enough to choose an extractor, since the bytes are identical either way.
type BlobRef struct {
	BLAKE3    content.Digest `json:"blake3"`
	Filename  string         `json:"filename"`
	MimeType  string         `json:"mime_type,omitempty"`
	SizeBytes int64          `json:"size_bytes"`
	// Messages counts how many messages carry this content.
	Messages int64 `json:"messages"`
	// Status is StatusPending when nothing has been extracted yet.
	Status    string `json:"status"`
	Extractor string `json:"extractor,omitempty"`
	Chars     int    `json:"chars"`
}

// ListBlobsOpts selects attachment content to work on or report.
type ListBlobsOpts struct {
	// Statuses filters by extraction status; StatusPending selects content
	// with no text row yet, read by neither a disk scan nor bank. Empty means
	// all of it.
	Statuses []string
	// Source restricts to files or message attachments of one source.
	Source string
	Limit  int
}

// MaxBlobList bounds one listing, the same reasoning as MaxSearchLimit.
const MaxBlobList = 5000

// ListBlobs returns distinct attachment content with its extraction status,
// largest first — a big scanned PDF is worth more than a signature image, and
// a bounded run should spend its budget there.
func (s *Store) ListBlobs(ctx context.Context, o ListBlobsOpts) ([]BlobRef, error) {
	if o.Limit <= 0 || o.Limit > MaxBlobList {
		o.Limit = MaxBlobList
	}
	args := []any{}
	next := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	where := ""
	if o.Source != "" {
		where = " where a.source = " + next(o.Source)
	}
	sql := `
		select c.blake3, b.filename, b.mime_type, c.size_bytes, b.messages,
		       coalesce(t.status, '` + StatusPending + `'), coalesce(t.extractor, ''),
		       coalesce(t.chars, 0)
		from (
			select a.content_id,
			       min(a.filename) as filename,
			       min(a.mime_type) as mime_type,
			       count(distinct a.message_id) as messages
			from (
                select a.content_id,a.filename,a.mime_type,a.message_id,m.source
                from attachments a join messages m on m.id=a.message_id
                union all
                select f.content_id,f.filename,f.mime_type,null::bigint,f.source
                from library_files f
            ) a` + where + `
			group by a.content_id
		) b
		join contents c on c.id = b.content_id
		left join texts t on t.content_id = b.content_id`
	if len(o.Statuses) > 0 {
		sql += " where coalesce(t.status, '" + StatusPending + "') = any(" + next(o.Statuses) + ")"
	}
	sql += " order by c.size_bytes desc, c.blake3 limit " + next(o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BlobRef{}
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.BLAKE3, &b.Filename, &b.MimeType, &b.SizeBytes, &b.Messages,
			&b.Status, &b.Extractor, &b.Chars); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// PutBlobText records one extraction outcome for a content the archive or a
// disk scan already knows, and the messages carrying it search the new text.
// Text over extract.MaxChars is cut, and ok text becomes truncated. Only
// manual text replaces manual text. needs_ocr queues an OCR job.
func (s *Store) PutBlobText(ctx context.Context, bt BlobText) error {
	if bt.BLAKE3.IsZero() || bt.Status == "" {
		return fmt.Errorf("text needs a digest and a status")
	}
	text, status := cleanText(bt.Text), bt.Status
	if len(text) > extract.MaxChars {
		text = truncateRunes(text, extract.MaxChars)
		if status == string(extract.StatusOK) {
			status = string(extract.StatusTruncated)
		}
	}
	return s.changeText(ctx, bt.BLAKE3, func(tx pgx.Tx, id int64) error {
		tag, err := tx.Exec(ctx, `
			insert into texts (content_id, text, extractor, status, extracted_at)
			values ($1, $2, $3, $4, now())
			on conflict (content_id) do update
			set text = excluded.text, extractor = excluded.extractor, status = excluded.status,
			    detail = '', extracted_at = now()
			where texts.status <> 'manual' or excluded.status = 'manual'`,
			id, text, cleanText(bt.Extractor), status)
		if err != nil || tag.RowsAffected() == 0 || status != string(extract.StatusNeedsOCR) {
			return err
		}
		return jobs.Insert(ctx, tx, jobs.OCR{ContentID: id})
	})
}

// changeText runs write on the content's text and refreshes the messages
// carrying it, all in one transaction that holds the contents row. Writing
// attachments takes the same row in share mode before it looks for text, so
// whichever transaction commits second sees the other's rows: a message
// attached while its text is being stored cannot miss it. Bytes the archive
// has never seen have no row, and nothing is written for them.
func (s *Store) changeText(ctx context.Context, d content.Digest, write func(pgx.Tx, int64) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var id int64
		err := tx.QueryRow(ctx, `select id from contents where blake3 = $1 for no key update`, d).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := write(tx, id); err != nil {
			return err
		}
		return refreshAttachmentText(ctx, tx, messagesCarrying, id)
	})
}

// truncateRunes cuts on a rune boundary. Plain byte-slicing would split a
// multi-byte character on a text that happens to be exactly the wrong length,
// and Postgres rejects invalid UTF-8 outright — the cap that exists to keep a
// row bounded must not be what makes the insert fail. The extractors have
// their own copy of this: they cap text long before it reaches here, and
// depending on this package for it would be a cycle.
func truncateRunes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}

func (s *Store) GetBlobText(ctx context.Context, d content.Digest) (BlobText, error) {
	var bt BlobText
	err := s.pool.QueryRow(ctx, `
		select c.blake3, t.text, t.extractor, t.status, t.chars, t.extracted_at
		from texts t join contents c on c.id = t.content_id where c.blake3 = $1`, d,
	).Scan(&bt.BLAKE3, &bt.Text, &bt.Extractor, &bt.Status, &bt.Chars, &bt.ExtractedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return bt, ErrNotFound
	}
	return bt, err
}

// DeleteBlobText drops an extraction result and queues the content to be
// read again. This is how a bad manual transcription is undone.
func (s *Store) DeleteBlobText(ctx context.Context, d content.Digest) error {
	deleted := false
	err := s.changeText(ctx, d, func(tx pgx.Tx, id int64) error {
		tag, err := tx.Exec(ctx, `delete from texts where content_id = $1`, id)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		deleted = true
		return jobs.Insert(ctx, tx, jobs.Text{ContentID: id})
	})
	if err == nil && !deleted {
		return ErrNotFound
	}
	return err
}

// TextSubject is a content as a text job reads it: Filename and MimeType come
// from one place the archive holds it.
type TextSubject struct {
	BLAKE3   content.Digest
	Filename string
	MimeType string
	// Status is StatusPending when the content has no text row.
	Status string
}

// TextSubject returns ErrNotFound when no attachment or library file holds the
// content any more, so there is nothing that would search its text.
func (s *Store) TextSubject(ctx context.Context, contentID int64) (TextSubject, error) {
	var t TextSubject
	err := s.pool.QueryRow(ctx, `
		select c.blake3, p.filename, p.mime_type, coalesce(t.status, '`+StatusPending+`')
		from contents c
		join lateral (
			select filename, mime_type from attachments where content_id = c.id
			union all
			select filename, mime_type from library_files where content_id = c.id
			limit 1) p on true
		left join texts t on t.content_id = c.id
		where c.id = $1`, contentID).Scan(&t.BLAKE3, &t.Filename, &t.MimeType, &t.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

// RefreshContentText recomputes the searchable text of the messages carrying
// the content. A text job calls it when it finds the content already read,
// such as by a disk scan, which writes text without touching messages.
func (s *Store) RefreshContentText(ctx context.Context, contentID int64) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `select from contents where id = $1 for no key update`, contentID); err != nil {
			return err
		}
		return refreshAttachmentText(ctx, tx, messagesCarrying, contentID)
	})
}

// queueText takes the contents rows that rows just written in tx name, in
// share mode (see changeText), and queues a text job for each content nothing
// has read yet and an OCR job for each that waits for OCR. A content already
// queued is not queued twice.
func queueText(ctx context.Context, tx pgx.Tx, contentIDs []int64) error {
	if len(contentIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `select from contents where id = any($1) order by id for share`, contentIDs); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
		select c.id, t.status from contents c left join texts t on t.content_id = c.id
		where c.id = any($1) and (t.status is null or t.status = 'needs_ocr')`, contentIDs)
	if err != nil {
		return err
	}
	queued, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (river.JobArgs, error) {
		var id int64
		var status *string
		if err := r.Scan(&id, &status); err != nil {
			return nil, err
		}
		if status == nil {
			return jobs.Text{ContentID: id}, nil
		}
		return jobs.OCR{ContentID: id}, nil
	})
	if err != nil {
		return err
	}
	return jobs.Insert(ctx, tx, queued...)
}

// KnownAttachment reports whether the archive holds this content, so a
// caller cannot store text for a digest the archive has never seen.
func (s *Store) KnownAttachment(ctx context.Context, d content.Digest) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `select exists (select 1 from contents c where c.blake3 = $1 and (
		exists (select 1 from attachments a where a.content_id = c.id) or
		exists (select 1 from library_files f where f.content_id = c.id)))`, d).Scan(&exists)
	return exists, err
}

// Message scopes for refreshAttachmentText, selecting with its $2.
const (
	messagesIn       = `select unnest($2::bigint[])`
	messagesCarrying = `select message_id from attachments where content_id = $2`
)

// refreshAttachmentText recomputes the denormalized column for the messages
// scope selects whose attachments' text no longer matches it. Every writer of
// attachments or text calls it in its own transaction, so there is no trigger
// and no archive-wide pass.
func refreshAttachmentText(ctx context.Context, tx pgx.Tx, scope string, arg any) error {
	_, err := tx.Exec(ctx, `
		update messages m
		set attachment_text = c.txt
		from (
			select a.message_id,
			       left(coalesce(string_agg(t.text, ' ' order by a.position), ''), $1) as txt
			from attachments a
			left join texts t on t.content_id = a.content_id and t.text <> ''
			where a.message_id in (`+scope+`)
			group by a.message_id
		) c
		where c.message_id = m.id and m.attachment_text is distinct from c.txt`,
		MaxAttachmentTextChars, arg)
	return err
}

// ExtractionStat is one status and how much content sits in it.
type ExtractionStat struct {
	Status string `json:"status"`
	Blobs  int64  `json:"blobs"`
	Bytes  int64  `json:"bytes"`
	Chars  int64  `json:"chars"`
}

// ExtractionStats answers "how much of the archive is searchable inside its
// attachments, and how much would OCR add" — the measurement that decides
// whether running OCR at all is worth it.
func (s *Store) ExtractionStats(ctx context.Context) ([]ExtractionStat, error) {
	rows, err := s.pool.Query(ctx, `
		select coalesce(t.status, '`+StatusPending+`') as status,
		       count(*), coalesce(sum(c.size_bytes), 0), coalesce(sum(t.chars), 0)
		from (select content_id from attachments union select content_id from library_files) b
		join contents c on c.id = b.content_id
		left join texts t on t.content_id = b.content_id
		group by 1 order by 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ExtractionStat{}
	for rows.Next() {
		var st ExtractionStat
		if err := rows.Scan(&st.Status, &st.Blobs, &st.Bytes, &st.Chars); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}
