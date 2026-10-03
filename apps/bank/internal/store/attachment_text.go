package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// StatusPending is the virtual status of a blob no extraction has touched
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

// BlobText is the extracted text of one blob, keyed by its digest.
type BlobText struct {
	SHA256      string    `json:"sha256"`
	Text        string    `json:"text"`
	Extractor   string    `json:"extractor,omitempty"`
	Status      string    `json:"status"`
	Chars       int       `json:"chars"`
	ExtractedAt time.Time `json:"extracted_at"`
}

// BlobRef is one distinct piece of attachment content and what is known about
// its text. Filename and MimeType come from an arbitrary message carrying it —
// enough to choose an extractor, since the bytes are identical either way.
type BlobRef struct {
	SHA256    string `json:"sha256"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type,omitempty"`
	SizeBytes int64  `json:"size_bytes"`
	// Messages counts how many messages carry this content.
	Messages int64 `json:"messages"`
	// Status is StatusPending when nothing has been extracted yet.
	Status    string `json:"status"`
	Extractor string `json:"extractor,omitempty"`
	Chars     int    `json:"chars"`
}

// ListBlobsOpts selects attachment content to work on or report.
type ListBlobsOpts struct {
	// Statuses filters by extraction status; StatusPending selects blobs with
	// no row yet. Empty means every blob.
	Statuses []string
	// Source restricts to blobs carried by messages of one source.
	Source string
	Limit  int
	// NewestFirst orders by the most recently stored attachment row instead of
	// by size. The pass that runs after an import needs it: with a backlog of
	// large pending blobs, the default order would spend a bounded batch
	// before ever reaching the file that just landed.
	NewestFirst bool
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
	where := ""
	if o.Source != "" {
		where = " where a.source = " + next(o.Source)
	}
	sql := `
		select b.sha256, b.filename, b.mime_type, b.size_bytes, b.messages,
		       coalesce(t.status, '` + StatusPending + `'), coalesce(t.extractor, ''),
		       coalesce(length(t.text), 0)
		from (
			select a.sha256,
			       min(a.filename) as filename,
			       min(a.mime_type) as mime_type,
			       max(a.size_bytes) as size_bytes,
			       count(distinct a.message_id) as messages,
			       max(a.newest) as newest
			from (
                select a.sha256,a.filename,a.mime_type,a.size_bytes,a.message_id,a.id as newest,m.source
                from attachments a join messages m on m.id=a.message_id
                union all
                select f.sha256,f.filename,f.mime_type,f.size_bytes,null::bigint,
                       (select coalesce(max(id),0) from attachments) + row_number() over(order by f.ingested_at,f.id),f.source
                from library_files f
            ) a` + where + `
			group by a.sha256
		) b
		left join blob_text t on t.sha256 = b.sha256`
	if len(o.Statuses) > 0 {
		sql += " where coalesce(t.status, '" + StatusPending + "') = any(" + next(o.Statuses) + ")"
	}
	// attachments.id only ever increases, so the highest one for a digest is
	// when that content was last stored.
	order := "b.size_bytes desc"
	if o.NewestFirst {
		order = "b.newest desc"
	}
	sql += " order by " + order + ", b.sha256 limit " + next(o.Limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BlobRef{}
	for rows.Next() {
		var b BlobRef
		if err := rows.Scan(&b.SHA256, &b.Filename, &b.MimeType, &b.SizeBytes, &b.Messages,
			&b.Status, &b.Extractor, &b.Chars); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// PutBlobText records one extraction outcome.
func (s *Store) PutBlobText(ctx context.Context, bt BlobText) error {
	if bt.SHA256 == "" || bt.Status == "" {
		return fmt.Errorf("blob text needs a sha256 and a status")
	}
	text := truncateRunes(cleanText(bt.Text), MaxAttachmentTextChars)
	_, err := s.pool.Exec(ctx, `
		insert into blob_text (sha256, text, extractor, status, extracted_at)
		values ($1, $2, $3, $4, now())
		on conflict (sha256) do update
		set text = excluded.text, extractor = excluded.extractor,
		    status = excluded.status, extracted_at = now()`,
		bt.SHA256, text, cleanText(bt.Extractor), bt.Status)
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

func (s *Store) GetBlobText(ctx context.Context, sha256 string) (BlobText, error) {
	var bt BlobText
	err := s.pool.QueryRow(ctx, `
		select sha256, text, extractor, status, length(text), extracted_at
		from blob_text where sha256 = $1`, sha256,
	).Scan(&bt.SHA256, &bt.Text, &bt.Extractor, &bt.Status, &bt.Chars, &bt.ExtractedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return bt, ErrNotFound
	}
	return bt, err
}

// DeleteBlobText drops an extraction result, putting the blob back in the
// pending queue. This is how a bad manual transcription is undone.
func (s *Store) DeleteBlobText(ctx context.Context, sha256 string) error {
	tag, err := s.pool.Exec(ctx, `delete from blob_text where sha256 = $1`, sha256)
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
func (s *Store) KnownAttachment(ctx context.Context, sha256 string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`select exists (select 1 from attachments where sha256 = $1) or exists(select 1 from library_files where sha256=$1)`, sha256).Scan(&exists)
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
func (s *Store) RefreshAttachmentText(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		update messages m
		set attachment_text = c.txt
		from (
			select a.message_id,
			       left(coalesce(string_agg(t.text, ' ' order by a.id), ''), $1) as txt
			from attachments a
			left join blob_text t on t.sha256 = a.sha256 and t.text <> ''
			group by a.message_id
		) c
		where c.message_id = m.id and m.attachment_text is distinct from c.txt`,
		MaxAttachmentTextChars)
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
		       count(*), coalesce(sum(b.size_bytes), 0), coalesce(sum(length(t.text)), 0)
		from (
			select sha256, max(size_bytes) as size_bytes
			from (select sha256,size_bytes from attachments union all select sha256,size_bytes from library_files) files group by sha256
		) b
		left join blob_text t on t.sha256 = b.sha256
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

// ValidSHA256 rejects anything that is not a digest before it reaches a query
// or a file path.
func ValidSHA256(s string) error {
	if len(s) != 64 {
		return fmt.Errorf("not a sha256 digest: %q", s)
	}
	if strings.TrimLeft(strings.ToLower(s), "0123456789abcdef") != "" {
		return fmt.Errorf("not a sha256 digest: %q", s)
	}
	return nil
}
