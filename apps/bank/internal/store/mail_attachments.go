package store

import "context"

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
	rows, err := transaction.Query(ctx, `select sha256,filename from attachments where message_id=$1`, messageID)
	if err != nil {
		return 0, err
	}
	have := make(map[string]int)
	for rows.Next() {
		var digest, filename string
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
	inserted := []string{}
	for _, attachment := range attachments {
		key := AttachmentKey(attachment.SHA256, attachment.Filename)
		if have[key] > 0 {
			have[key]--
			continue
		}
		if _, err := transaction.Exec(ctx, `insert into attachments(message_id,filename,mime_type,size_bytes,sha256) values($1,$2,$3,$4,$5)`, messageID, cleanText(attachment.Filename), cleanText(attachment.MimeType), attachment.SizeBytes, attachment.SHA256); err != nil {
			return 0, err
		}
		inserted = append(inserted, attachment.SHA256)
	}
	if err := transaction.Commit(ctx); err != nil {
		return 0, err
	}
	for _, digest := range inserted {
		countImported(ctx, 0, digest)
	}
	return len(inserted), nil
}
