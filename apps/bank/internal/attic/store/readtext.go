package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// ReadText returns the complete text read from the content with this BLAKE3
// digest: the document's own text where it has any, an OCR result otherwise.
// Truncated text is not returned, because a caller with the bytes can read
// more of it than the catalogue kept.
func (s *Store) ReadText(ctx context.Context, blake3 []byte) (text, extractor string, err error) {
	err = s.pool.QueryRow(ctx, `
		select found.text, found.extractor from (
			select t.text, t.extractor, 0 as rank, t.extracted_at as at
			from texts t join contents c on c.id = t.content_id
			where c.blake3 = $1 and t.status = 'ok' and t.text <> ''
			union all
			select a.text, 'ocr ' || a.provider || ' ' || a.model, 1, a.updated_at
			from ai_results a join contents c on c.id = a.content_id
			where c.blake3 = $1 and a.task = 'ocr' and a.status = 'ok' and a.text <> ''
		) found order by found.rank, found.at desc limit 1`, blake3).Scan(&text, &extractor)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", ErrNotFound
	}
	return text, extractor, err
}
