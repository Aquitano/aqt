package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
)

// PendingArchive is a hashed archive below the scan root whose content has
// no listing yet.
type PendingArchive struct {
	ID        int64
	Path      string
	Size      int64
	ContentID int64
}

// pendingArchiveWhere matches the names archive.IsArchive accepts, below an
// upper path bound; the callers add the lower one as $5.
const pendingArchiveWhere = `
	from entries e
	where e.volume_id = $1 and e.kind = 'file' and e.hash_state = 'done' and e.missing_scan is null
	  and (e.ext = any($2) or (e.ext = any($3) and lower(e.name) like ('%.tar.' || e.ext)))
	  and not exists (select 1 from archives a where a.content_id = e.content_id)
	  and ($4 = '' or e.path collate "C" < $4)`

// ArchiveTotals is the listing work left below the scan root, one per content.
func (sc *Scan) ArchiveTotals(ctx context.Context) (int64, error) {
	lower, upper := sc.subtree()
	var n int64
	err := sc.store.pool.QueryRow(ctx, `select count(distinct e.content_id)`+pendingArchiveWhere+` and e.path collate "C" > $5`,
		sc.Volume.ID, archive.Extensions, archive.Compressed, upper, lower).Scan(&n)
	return n, err
}

// NextArchives returns up to limit archives after the given one, in path
// order. Copies of one content can both come back; the first to be listed
// settles the other.
func (sc *Scan) NextArchives(ctx context.Context, after PendingArchive, limit int) ([]PendingArchive, error) {
	lower, upper := sc.subtree()
	if after.ID != 0 {
		lower = after.Path
	}
	rows, err := sc.store.pool.Query(ctx, `select e.id, e.path, e.size_bytes, e.content_id`+pendingArchiveWhere+`
		  and (e.path collate "C" > $5 or (e.path = $5 and e.id > $6))
		order by e.path collate "C", e.id limit $7`,
		sc.Volume.ID, archive.Extensions, archive.Compressed, upper, lower, after.ID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PendingArchive, error) {
		var p PendingArchive
		err := r.Scan(&p.ID, &p.Path, &p.Size, &p.ContentID)
		return p, err
	})
}

// Listing writes one archive's members in a transaction of its own, so a
// listing is either whole or absent: an interrupted one is redone by the next
// scan. Members are copied in batches as they are read.
type Listing struct {
	sc        *Scan
	tx        pgx.Tx
	contentID int64
	rows      [][]any
	members   int64
}

const listingBatch = 5000

// StartListing claims a content for listing. It returns nil when another scan
// listed it first; one listing the same content right now holds the claim
// until it commits.
func (sc *Scan) StartListing(ctx context.Context, contentID int64) (*Listing, error) {
	tx, err := sc.store.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `insert into archives (content_id, status) values ($1, 'listing') on conflict do nothing`, contentID)
	if err != nil || tag.RowsAffected() == 0 {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	return &Listing{sc: sc, tx: tx, contentID: contentID}, nil
}

func (l *Listing) Add(ctx context.Context, m archive.Member) error {
	var crc *int64
	if m.CRC32 != nil {
		v := int64(*m.CRC32)
		crc = &v
	}
	name := cleanText(m.Name)
	l.rows = append(l.rows, []any{l.contentID, m.Kind, name, cleanText(m.Path), ext(m.Kind, name), m.Size,
		nullTime(m.Modified), crc, m.Encrypted})
	l.members++
	// Counted as read, so progress moves through a large archive; Abort takes
	// them back.
	l.sc.Counts.Members++
	if len(l.rows) >= listingBatch {
		return l.flush(ctx)
	}
	return nil
}

func (l *Listing) flush(ctx context.Context) error {
	if len(l.rows) == 0 {
		return nil
	}
	_, err := l.tx.CopyFrom(ctx, pgx.Identifier{"members"},
		[]string{"archive_id", "kind", "name", "path", "ext", "size_bytes", "modified_at", "crc32", "encrypted"},
		pgx.CopyFromRows(l.rows))
	l.rows = l.rows[:0]
	return err
}

// Finish records how reading the archive went and commits its members.
func (l *Listing) Finish(ctx context.Context, res archive.Result) error {
	if err := l.flush(ctx); err != nil {
		l.Abort(ctx)
		return err
	}
	if _, err := l.tx.Exec(ctx, `update archives set format = $2, status = $3, detail = $4, members = $5
		where content_id = $1`, l.contentID, res.Format, res.Status, cleanText(res.Detail), l.members); err != nil {
		l.Abort(ctx)
		return err
	}
	if err := l.tx.Commit(ctx); err != nil {
		l.Abort(ctx)
		return err
	}
	l.sc.Counts.Archives++
	return nil
}

// Abort drops a listing that did not finish, leaving the archive to the next
// scan.
func (l *Listing) Abort(ctx context.Context) {
	_ = l.tx.Rollback(context.WithoutCancel(ctx))
	l.sc.Counts.Members -= l.members
}
