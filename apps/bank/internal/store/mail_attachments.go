package store

import (
	"context"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

func (s *Store) ReconcileMailAttachments(ctx context.Context, messageID int64, attachments []Attachment) (int, error) {
	transaction, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	var locked int64
	if err := transaction.QueryRow(ctx, `select id from messages where id=$1 for update`, messageID).Scan(&locked); err != nil {
		return 0, err
	}
	rows, err := transaction.Query(ctx, `select c.blake3,a.filename from attachments a join contents c on c.id=a.content_id where a.message_id=$1`, messageID)
	if err != nil {
		return 0, err
	}
	have := make(map[string]int)
	for rows.Next() {
		var digest content.Digest
		var filename string
		if err := rows.Scan(&digest, &filename); err != nil {
			rows.Close()
			return 0, err
		}
		have[AttachmentKey(digest, filename)]++
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	inserted := []content.Digest{}
	for _, attachment := range attachments {
		key := AttachmentKey(attachment.BLAKE3, attachment.Filename)
		if have[key] > 0 {
			have[key]--
			continue
		}
		attachment.MessageID = messageID
		if err := insertAttachment(ctx, transaction, attachment); err != nil {
			return 0, err
		}
		inserted = append(inserted, attachment.BLAKE3)
	}
	if err := transaction.Commit(ctx); err != nil {
		return 0, err
	}
	for _, digest := range inserted {
		countImported(ctx, 0, digest)
	}
	return len(inserted), nil
}
