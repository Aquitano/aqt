package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
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

func (sc *Scan) ArchivePart(ctx context.Context, path string) (ContentFile, error) {
	var p ContentFile
	var digest []byte
	err := sc.lock.QueryRow(ctx, `select e.id, e.path, c.id, c.size_bytes, c.blake3
		from entries e join contents c on c.id = e.content_id
		where e.volume_id = $1 and e.path = $2 and e.kind = 'file'
		and e.hash_state = 'done' and e.missing_scan is null
		order by e.id limit 1`, sc.Volume.ID, path).Scan(&p.ID, &p.Path, &p.ContentID, &p.Size, &digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, fmt.Errorf("archive part %q needs hashing before listing: %w", path, ErrNotFound)
	}
	copy(p.Digest[:], digest)
	return p, err
}
