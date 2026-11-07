package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// PendingArchive is a hashed archive below the scan root whose content has
// no listing at the requested depth yet.
type PendingArchive struct {
	ID        int64
	Path      string
	Size      int64
	ContentID int64
	Digest    disk.Digest
	Depth     int
}

// Each disjoint policy range drives an entries_path_idx scan. The lateral
// barriers prevent rebuilding a whole-cache hash table for each range.
const pendingArchiveWhere = `
	from entries e join contents c on c.id = e.content_id
	left join lateral (select content_id, depth from archives where content_id = e.content_id offset 0) a on true
	where e.volume_id = $1 and e.kind = 'file' and e.hash_state = 'done' and e.missing_scan is null
	  and e.path collate "C" >= policy.lower and e.path collate "C" < policy.upper
	  and (e.ext = any($2) or (e.ext = any($3) and lower(e.name) like ('%.tar.' || e.ext)))
	  and (a.content_id is null or a.depth < policy.depth)
	  and not exists (select 1 from archive_depth_failures f
		where f.content_id = e.content_id and f.depth = policy.depth and f.unpack_max_bytes = $8 offset 0)
	  and ($4 = '' or e.path collate "C" < $4)`

// ArchiveTotals is the listing work left below the scan root, one per content.
func (sc *Scan) ArchiveTotals(ctx context.Context, ranges []config.ArchiveRange, unpackMaxBytes int64) (int64, error) {
	lower, upper := sc.subtree()
	lowers, uppers, depths := archiveRangeArrays(ranges)
	var n int64
	err := sc.store.pool.QueryRow(ctx, `select count(distinct candidate.content_id)
		from unnest($5::text[], $6::text[], $7::int[]) as policy(lower, upper, depth)
		cross join lateral (select e.content_id`+pendingArchiveWhere+`
			and e.path collate "C" > $9 offset 0) candidate
		where policy.upper collate "C" > $9 and ($4 = '' or policy.lower collate "C" < $4)`,
		sc.Volume.ID, archive.Extensions, archive.Compressed, upper, lowers, uppers, depths, unpackMaxBytes, lower).Scan(&n)
	return n, err
}

// NextArchives returns up to limit archives after the given one, in path
// order. A completed listing settles copies requesting no greater depth.
// Disjoint ranges can be ordered first so the limit stops before later ranges.
func (sc *Scan) NextArchives(ctx context.Context, after PendingArchive, limit int, ranges []config.ArchiveRange, unpackMaxBytes int64) ([]PendingArchive, error) {
	lower, upper := sc.subtree()
	lowers, uppers, depths := archiveRangeArrays(ranges)
	if after.ID != 0 {
		lower = after.Path
	}
	rows, err := sc.store.pool.Query(ctx, `select candidate.*
		from (select * from unnest($5::text[], $6::text[], $7::int[]) as p(lower, upper, depth)
			order by p.lower collate "C") policy
		cross join lateral (
			select e.id, e.path, c.size_bytes, e.content_id, c.blake3, coalesce(a.depth, 0)`+pendingArchiveWhere+`
			and (e.path collate "C", e.id) > ($9, $10)
			order by e.path collate "C", e.id limit $11
		) candidate
		where policy.upper collate "C" > $9 and ($4 = '' or policy.lower collate "C" < $4)
		order by policy.lower collate "C", candidate.path collate "C", candidate.id limit $11`,
		sc.Volume.ID, archive.Extensions, archive.Compressed, upper, lowers, uppers, depths, unpackMaxBytes, lower, after.ID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (PendingArchive, error) {
		var p PendingArchive
		var digest []byte
		err := r.Scan(&p.ID, &p.Path, &p.Size, &p.ContentID, &digest, &p.Depth)
		copy(p.Digest[:], digest)
		return p, err
	})
}

func archiveRangeArrays(ranges []config.ArchiveRange) ([]string, []string, []int) {
	lowers, uppers, depths := make([]string, len(ranges)), make([]string, len(ranges)), make([]int, len(ranges))
	for i, r := range ranges {
		lowers[i], uppers[i], depths[i] = r.Lower, r.Upper, r.Depth
	}
	return lowers, uppers, depths
}

// Listing writes one archive's members in a transaction of its own, so a
// listing replaces the previous cache only when committed. Members are copied
// in batches as they are read.
type Listing struct {
	sc             *Scan
	tx             pgx.Tx
	contentID      int64
	rows           [][]any
	members        int64
	replacing      bool
	depth          int
	unpackMaxBytes int64
}

const listingBatch = 5000

// StartListing claims a content for listing at depth. It returns nil when the
// cache is deep enough, has an unknown legacy depth, or remembers an attempt
// at this depth and unpack limit. Another listing holds the claim until it commits.
func (sc *Scan) StartListing(ctx context.Context, contentID int64, depth int, unpackMaxBytes int64) (*Listing, error) {
	tx, err := sc.store.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err := lockContentCache(ctx, tx, true); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	tag, err := tx.Exec(ctx, `insert into archives (content_id, status, depth) values ($1, 'listing', $2)
		on conflict (content_id) do nothing`, contentID, depth)
	if err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	replacing := tag.RowsAffected() == 0
	if replacing {
		if _, err := tx.Exec(ctx, `savepoint previous_listing`); err != nil {
			_ = tx.Rollback(context.WithoutCancel(ctx))
			return nil, err
		}
		tag, err = tx.Exec(ctx, `update archives set status = 'listing', depth = $2
			where content_id = $1 and depth < $2
			and not exists (select 1 from archive_depth_failures where content_id = $1 and depth = $2 and unpack_max_bytes = $3)`, contentID, depth, unpackMaxBytes)
		if err != nil || tag.RowsAffected() == 0 {
			_ = tx.Rollback(context.WithoutCancel(ctx))
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `delete from members where archive_id = $1`, contentID); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, err
	}
	return &Listing{sc: sc, tx: tx, contentID: contentID, replacing: replacing, depth: depth, unpackMaxBytes: unpackMaxBytes}, nil
}

func (l *Listing) Add(ctx context.Context, m archive.Member) error {
	var crc *int64
	if m.CRC32 != nil {
		v := int64(*m.CRC32)
		crc = &v
	}
	modified := nullTime(m.Modified)
	// A tar header can claim any year; Postgres stops at 294276.
	if y := m.Modified.Year(); y < 1 || y > 9999 {
		modified = nil
	}
	name := cleanText(m.Name)
	l.rows = append(l.rows, []any{l.contentID, m.Kind, name, cleanText(m.Path), ext(m.Kind, name), m.Size,
		modified, crc, m.Encrypted})
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
	if l.replacing && (res.Status != archive.Listed || res.Incomplete) {
		if !res.CacheableFailure {
			l.Abort(ctx)
			return ctx.Err()
		}
		if _, err := l.tx.Exec(ctx, `rollback to savepoint previous_listing`); err != nil {
			l.Abort(ctx)
			return err
		}
		if _, err := l.tx.Exec(ctx, `insert into archive_depth_failures (content_id, depth, unpack_max_bytes) values ($1, $2, $3)
			on conflict do nothing`, l.contentID, l.depth, l.unpackMaxBytes); err != nil {
			l.Abort(ctx)
			return err
		}
		if err := l.tx.Commit(ctx); err != nil {
			l.Abort(ctx)
			return err
		}
		l.tx = nil
		l.sc.Counts.Members -= l.members
		return nil
	}
	if err := l.flush(ctx); err != nil {
		l.Abort(ctx)
		return err
	}
	if _, err := l.tx.Exec(ctx, `update archives set format = $2, status = $3, detail = $4, members = $5, listed_at = clock_timestamp()
		where content_id = $1`, l.contentID, res.Format, res.Status, cleanText(res.Detail), l.members); err != nil {
		l.Abort(ctx)
		return err
	}
	if err := l.tx.Commit(ctx); err != nil {
		l.Abort(ctx)
		return err
	}
	l.tx = nil
	l.sc.Counts.Archives++
	return nil
}

// Abort drops an unfinished listing, preserving any previously committed cache.
func (l *Listing) Abort(ctx context.Context) {
	if l.tx == nil {
		return
	}
	_ = l.tx.Rollback(context.WithoutCancel(ctx))
	l.tx = nil
	l.sc.Counts.Members -= l.members
}
