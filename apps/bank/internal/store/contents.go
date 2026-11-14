package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/content"
)

// upsertContent returns the id of the contents row for d, creating it when
// neither the archive nor a disk scan has seen these bytes. It does not lock
// an existing row: the insert waits only for a concurrent insert of the same
// digest, and the select that follows runs on a fresh snapshot that sees it.
func upsertContent(ctx context.Context, tx pgx.Tx, d content.Digest, size int64) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `insert into contents (blake3, size_bytes) values ($1, $2)
		on conflict (blake3) do nothing returning id`, d, size).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `select id from contents where blake3 = $1`, d).Scan(&id)
	}
	return id, err
}

// insertAttachment stores one attachment row and the contents row it names,
// unless the message already holds an attachment at that position.
func insertAttachment(ctx context.Context, tx pgx.Tx, a Attachment) (contentID int64, added bool, err error) {
	contentID, err = upsertContent(ctx, tx, a.BLAKE3, a.SizeBytes)
	if err != nil {
		return 0, false, err
	}
	tag, err := tx.Exec(ctx, `insert into attachments (message_id, position, filename, mime_type, content_id) values ($1, $2, $3, $4, $5)
		on conflict (message_id, position) do nothing`,
		a.MessageID, a.Position, cleanText(a.Filename), cleanText(a.MimeType), contentID)
	return contentID, tag.RowsAffected() == 1, err
}

// UpsertContent records bytes already in the blob store and returns their
// contents row.
func (s *Store) UpsertContent(ctx context.Context, d content.Digest, size int64) (int64, error) {
	var id int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		id, err = upsertContent(ctx, tx, d, size)
		return err
	})
	return id, err
}

// ArchivePlace is one place the archive holds a content: attached to
// messages, or as a library file.
type ArchivePlace struct {
	Filename string
	// LibraryFileID is set for a library file, empty for a message attachment.
	LibraryFileID string
}

// ArchivePlaces lists where the archive holds the bytes with this digest,
// library files first. It is empty when the archive holds no such bytes.
func (s *Store) ArchivePlaces(ctx context.Context, d content.Digest) ([]ArchivePlace, error) {
	rows, err := s.pool.Query(ctx, `
		select filename, file_id from (
			select f.filename, f.id as file_id from contents c join library_files f on f.content_id = c.id where c.blake3 = $1
			union
			select a.filename, '' from contents c join attachments a on a.content_id = c.id where c.blake3 = $1) places
		order by file_id = '', filename, file_id limit 50`, d)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (ArchivePlace, error) {
		var p ArchivePlace
		err := r.Scan(&p.Filename, &p.LibraryFileID)
		return p, err
	})
}
