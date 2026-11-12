package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// BlobsWithoutDigest pages through the stored blobs that have no BLAKE3
// digest yet, in SHA-256 order after the given one.
func (s *Store) BlobsWithoutDigest(ctx context.Context, after string, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		select b.sha256 from (select sha256 from attachments union select sha256 from library_files) b
		where b.sha256 > $1 and not exists (select from blob_digests d where d.sha256 = b.sha256)
		order by b.sha256 limit $2`, after, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (s *Store) SetBlobDigest(ctx context.Context, sha256 string, blake3 []byte) error {
	_, err := s.pool.Exec(ctx, `insert into blob_digests (sha256, blake3) values ($1, $2)
		on conflict (sha256) do update set blake3 = excluded.blake3`, sha256, blake3)
	return err
}

// BlobDigest is the BLAKE3 digest of a stored blob, or nil before the digest
// pass has read it.
func (s *Store) BlobDigest(ctx context.Context, sha256 string) ([]byte, error) {
	var digest []byte
	err := s.pool.QueryRow(ctx, `select blake3 from blob_digests where sha256 = $1`, sha256).Scan(&digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return digest, err
}

// BlobFilenames lists the names a stored blob goes by, library files first.
// It is empty when the archive holds no such blob.
func (s *Store) BlobFilenames(ctx context.Context, sha256 string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		select filename from (
			select filename, 0 as attached from library_files where sha256 = $1
			union select filename, 1 from attachments where sha256 = $1) names
		order by attached, filename limit 20`, sha256)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// StoredBlob is one place the archive holds a blob: attached to messages, or
// as a library file.
type StoredBlob struct {
	SHA256   string
	Filename string
	// LibraryFileID is set for a library file, empty for a message attachment.
	LibraryFileID string
}

// BlobsWithDigest lists where the archive holds the bytes with this BLAKE3
// digest, one row per blob and filename.
func (s *Store) BlobsWithDigest(ctx context.Context, blake3 []byte) ([]StoredBlob, error) {
	rows, err := s.pool.Query(ctx, `
		select d.sha256, f.filename, f.id from blob_digests d join library_files f on f.sha256 = d.sha256 where d.blake3 = $1
		union
		select d.sha256, a.filename, '' from blob_digests d join attachments a on a.sha256 = d.sha256 where d.blake3 = $1
		order by 1, 2, 3 limit 50`, blake3)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (StoredBlob, error) {
		var b StoredBlob
		err := r.Scan(&b.SHA256, &b.Filename, &b.LibraryFileID)
		return b, err
	})
}
