package store

import (
	"context"
	"slices"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// Older scans could retain a moved link's digest while acknowledging a new
// change time. Verify it when another link needs hashing or disagrees with it.
func (sc *Scan) QueueHardLinkHashes(ctx context.Context) error {
	if !sc.Volume.StableIDs {
		return nil
	}
	tx, err := sc.begin(ctx)
	if err != nil {
		return err
	}
	lower, upper := sc.subtree()
	result, err := tx.Exec(ctx, `
		update entries e set hash_state = 'pending'
		where e.volume_id = $1 and e.kind = 'file' and e.missing_scan is null
		  and e.hash_state = 'done' and e.physical_file_id is not null
		  and e.path collate "C" > $2 and ($3 = '' or e.path collate "C" < $3)
		  and exists(select 1 from entries link
		             where link.volume_id = e.volume_id and link.physical_file_id = e.physical_file_id
		               and link.id <> e.id and link.kind = 'file' and link.missing_scan is null
		               and (link.hash_state in ('pending', 'failed')
		                    or (link.hash_state = 'done' and link.content_id is distinct from e.content_id))
		               and link.size_bytes = e.size_bytes and link.modified_at = e.modified_at
		               and link.changed_at = e.changed_at
		               and link.path collate "C" > $2 and ($3 = '' or link.path collate "C" < $3))`,
		sc.Volume.ID, lower, upper)
	if err != nil {
		return err
	}
	sc.dirty += int(result.RowsAffected())
	return nil
}

func (sc *Scan) ReuseContent(ctx context.Context, p Pending, observed disk.Entry) (bool, error) {
	if !sc.Volume.StableIDs || p.PhysicalFileID == nil || int64(observed.FileID) != *p.PhysicalFileID ||
		observed.Dir || observed.Link || observed.Remote || observed.Size != p.Size ||
		observed.Modified.IsZero() || observed.Changed.IsZero() {
		return false, nil
	}
	lower, upper := sc.subtree()
	if slices.ContainsFunc(sc.hashes, func(h completedHash) bool {
		return h.file.ID != p.ID && samePtr(h.file.PhysicalFileID, p.PhysicalFileID) && h.file.Size == p.Size &&
			h.file.Path > lower && (upper == "" || h.file.Path < upper)
	}) {
		if err := sc.flushContents(ctx); err != nil {
			return false, err
		}
	}
	tx, err := sc.begin(ctx)
	if err != nil {
		return false, err
	}
	l := normalize(Listed{Modified: observed.Modified, Changed: observed.Changed}, true)
	result, err := tx.Exec(ctx, `
		update entries e set content_id = known.content_id, hash_state = 'done', updated_scan = $6
		from entries known
		where e.id = $1 and e.volume_id = $2 and e.physical_file_id = $3
		  and e.kind = 'file' and e.missing_scan is null and e.hash_state in ('pending', 'failed')
		  and e.size_bytes = $4 and e.modified_at = $5 and e.changed_at = $7
		  and known.volume_id = e.volume_id and known.physical_file_id = e.physical_file_id
		  and known.id <> e.id and known.kind = 'file' and known.missing_scan is null
		  and known.hash_state = 'done' and known.content_id is not null
		  and known.path collate "C" > $8 and ($9 = '' or known.path collate "C" < $9)
		  and known.size_bytes = e.size_bytes and known.modified_at = e.modified_at and known.changed_at = e.changed_at`,
		p.ID, sc.Volume.ID, p.PhysicalFileID, p.Size, l.Modified, sc.ID, l.Changed, lower, upper)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() == 0 {
		return false, nil
	}
	sc.Counts.Duplicates++
	sc.dirty++
	return true, nil
}
