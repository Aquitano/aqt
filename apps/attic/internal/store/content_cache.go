package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func lockContentCache(ctx context.Context, tx pgx.Tx, shared bool) error {
	lock := "pg_advisory_xact_lock"
	if shared {
		lock = "pg_advisory_xact_lock_shared"
	}
	_, err := tx.Exec(ctx, `select `+lock+`(hashtextextended('attic-content-cache', 0))`)
	return err
}

// RebuildContent invalidates shared archive and text facts for present hashed
// contents in this subtree. Copies elsewhere share the rebuilt results.
func (sc *Scan) RebuildContent(ctx context.Context) error {
	tx, err := sc.store.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if err := lockContentCache(ctx, tx, false); err != nil {
		return err
	}
	lower, upper := sc.subtree()
	const selected = `select content_id from entries
		where volume_id = $1 and kind = 'file' and hash_state = 'done' and missing_scan is null
		and path collate "C" > $2 and ($3 = '' or path collate "C" < $3)`
	for _, query := range []string{
		`delete from members where archive_id in (` + selected + `)`,
		`delete from archives where content_id in (` + selected + `)`,
		`delete from texts where content_id in (` + selected + `)`,
	} {
		if _, err := tx.Exec(ctx, query, sc.Volume.ID, lower, upper); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// Stamp is how the catalogue last saw a hashed file, and the digest it
// recorded. A changed size, modified time, change time or physical ID resets
// content before a listing updates these fields.
type Stamp struct {
	Size     int64
	Modified *time.Time
	Changed  *time.Time
	FileID   *int64
	Digest   disk.Digest
}

const stampColumns = `e.size_bytes, e.modified_at, e.changed_at, e.physical_file_id, c.blake3`

func (s *Stamp) fields() []any {
	return []any{&s.Size, &s.Modified, &s.Changed, &s.FileID, (*digestColumn)(&s.Digest)}
}

type digestColumn disk.Digest

func (d *digestColumn) Scan(src any) error {
	b, ok := src.([]byte)
	if !ok || len(b) != len(d) {
		return fmt.Errorf("blake3 column holds %T of %d bytes", src, len(b))
	}
	copy(d[:], b)
	return nil
}

func (s Stamp) Matches(e disk.Entry) bool {
	stored := func(t time.Time) time.Time { return t.UTC().Truncate(time.Microsecond) }
	return s.Size == e.Size && sameTime(s.Modified, stored(e.Modified)) && sameTime(s.Changed, stored(e.Changed)) &&
		(s.FileID == nil || *s.FileID == int64(e.FileID))
}

// ArchivePart returns how the catalogue last saw a multipart archive's sibling
// volume.
func (sc *Scan) ArchivePart(ctx context.Context, path string) (Stamp, error) {
	var s Stamp
	err := sc.lock.QueryRow(ctx, `select `+stampColumns+`
		from entries e join contents c on c.id = e.content_id
		where e.volume_id = $1 and e.path = $2 and e.kind = 'file'
		and e.hash_state = 'done' and e.missing_scan is null
		order by e.id limit 1`, sc.Volume.ID, path).Scan(s.fields()...)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, fmt.Errorf("archive part %q needs hashing before listing: %w", path, ErrNotFound)
	}
	return s, err
}
