package store

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

// HeldContent is one content the archive holds bytes for: an attachment, a
// library file or a raw input.
type HeldContent struct {
	BLAKE3    content.Digest
	SizeBytes int64
	// Uses names up to three of the records that hold it, and Holders counts
	// them all.
	Uses    []string
	Holders int64
}

// EachHeldContent streams every content an attachment, a library file or a
// raw input refers to, once each.
func (s *Store) EachHeldContent(ctx context.Context, fn func(HeldContent) error) error {
	rows, err := s.pool.Query(ctx, `
		with uses as (
			select a.content_id, m.ref || ' attachment ' || a.position as name
			from attachments a join messages m on m.id = a.message_id
			union all select f.content_id, f.id from library_files f
			union all select r.content_id, 'raw input ' || r.id from raw_inputs r)
		select c.blake3, c.size_bytes, (array_agg(u.name order by u.name))[1:3], count(*)
		from uses u join contents c on c.id = u.content_id
		group by c.id order by c.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var held HeldContent
		if err := rows.Scan(&held.BLAKE3, &held.SizeBytes, &held.Uses, &held.Holders); err != nil {
			return err
		}
		if err := fn(held); err != nil {
			return err
		}
	}
	return rows.Err()
}
