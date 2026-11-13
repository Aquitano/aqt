package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/packages/go/extract"
	"github.com/jackc/pgx/v5"
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
	// NewestFirst orders by the most recently stored file instead of
	// by size. The pass that runs after an import needs it: with a backlog of
	// large pending blobs, the default order would spend a bounded batch
	// before ever reaching the file that just landed.
	NewestFirst bool
	// StoredSince restricts to content stored at or after it, so the passes
	// after an upload drain what uploads stored without taking on the
	// archive's older backlog.
	StoredSince time.Time
}

// MaxBlobList bounds one listing, the same reasoning as MaxSearchLimit.
const MaxBlobList = 5000

// ListBlobs returns distinct attachment content with its extraction status,
// largest first — a big scanned PDF is worth more than a signature image, and
// a bounded run should spend its budget there. NewestFirst is the exception,
// for the pass that has to reach what an import just stored.
func (s *Store) ListBlobs(ctx context.Context, o ListBlobsOpts) ([]BlobRef, error) {
	if o.Limit <= 0 || o.Limit > MaxBlobList {
		o.Limit = MaxBlobList
	}
	args := []any{}
	next := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	conditions := []string{}
	if o.Source != "" {
		conditions = append(conditions, "a.source = "+next(o.Source))
	}
	if !o.StoredSince.IsZero() {
		conditions = append(conditions, "a.newest >= "+next(o.StoredSince))
	}
	where := ""
	if len(conditions) > 0 {
		where = " where " + strings.Join(conditions, " and ")
	}
	sql := `
		select c.blake3, b.filename, b.mime_type, c.size_bytes, b.messages,
		       coalesce(t.status, '` + StatusPending + `'), coalesce(t.extractor, ''),
		       coalesce(t.chars, 0)
		from (
			select a.content_id,
			       min(a.filename) as filename,
			       min(a.mime_type) as mime_type,
			       count(distinct a.message_id) as messages,
			       max(a.newest) as newest,
			       max(a.attachment_id) as attachment_id
			from (
                select a.content_id,a.filename,a.mime_type,a.message_id,
                       coalesce(a.ingested_at,m.ingested_at) as newest,a.id as attachment_id,m.source
                from attachments a join messages m on m.id=a.message_id
                union all
                select f.content_id,f.filename,f.mime_type,null::bigint,
                       f.ingested_at,0::bigint,f.source
                from library_files f
            ) a` + where + `
			group by a.content_id
		) b
		join contents c on c.id = b.content_id
		left join texts t on t.content_id = b.content_id`
	if len(o.Statuses) > 0 {
		sql += " where coalesce(t.status, '" + StatusPending + "') = any(" + next(o.Statuses) + ")"
	}
	order := "c.size_bytes desc"
	if o.NewestFirst {
		order = "b.newest desc, b.attachment_id desc"
	}
	sql += " order by " + order + ", c.blake3 limit " + next(o.Limit)

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
// disk scan already knows. Text over extract.MaxChars is cut, and ok text
// becomes truncated. Only manual text replaces manual text.
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
	_, err := s.pool.Exec(ctx, `
		insert into texts (content_id, text, extractor, status, extracted_at)
		select c.id, $2, $3, $4, now() from contents c where c.blake3 = $1
		on conflict (content_id) do update
		set text = excluded.text, extractor = excluded.extractor, status = excluded.status,
		    detail = '', extracted_at = now()
		where texts.status <> 'manual' or excluded.status = 'manual'`,
		bt.BLAKE3, text, cleanText(bt.Extractor), status)
	return err
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

// DeleteBlobText drops an extraction result, putting the content back in the
// pending queue. This is how a bad manual transcription is undone.
func (s *Store) DeleteBlobText(ctx context.Context, d content.Digest) error {
	tag, err := s.pool.Exec(ctx, `delete from texts t using contents c where c.id = t.content_id and c.blake3 = $1`, d)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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

// RefreshAttachmentText recomputes the denormalized column for every message
// whose attachments' text no longer matches it, and returns how many rows
// changed.
//
// One idempotent statement rather than triggers or bookkeeping: it covers a
// blob that was just extracted, a message imported after its blob was already
// extracted, and text corrected by hand, without any of them needing to know
// about the others.
//
// A non-zero since limits it to messages with an attachment stored or
// extracted at or after since, which is all a pass after an upload can have
// changed, including older messages sharing content it just read.
func (s *Store) RefreshAttachmentText(ctx context.Context, since time.Time) (int64, error) {
	args := []any{MaxAttachmentTextChars}
	scope := ""
	if !since.IsZero() {
		args = append(args, since)
		scope = `where a.message_id in (
				select s.message_id from attachments s
				join messages sm on sm.id = s.message_id
				left join texts st on st.content_id = s.content_id
				where coalesce(s.ingested_at, sm.ingested_at) >= $2 or st.extracted_at >= $2)`
	}
	tag, err := s.pool.Exec(ctx, `
		update messages m
		set attachment_text = c.txt
		from (
			select a.message_id,
			       left(coalesce(string_agg(t.text, ' ' order by a.id), ''), $1) as txt
			from attachments a
			left join texts t on t.content_id = a.content_id and t.text <> ''
			`+scope+`
			group by a.message_id
		) c
		where c.message_id = m.id and m.attachment_text is distinct from c.txt`,
		args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
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
