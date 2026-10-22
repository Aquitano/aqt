package store

import (
	"context"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func (sc *Scan) ReuseContent(ctx context.Context, p Pending, observed disk.Entry) (bool, error) {
	if !sc.Volume.StableIDs || p.PhysicalFileID == nil || int64(observed.FileID) != *p.PhysicalFileID ||
		observed.Dir || observed.Link || observed.Remote || observed.Size != p.Size ||
		observed.Modified.IsZero() || observed.Changed.IsZero() {
		return false, nil
	}
	if err := sc.flushContents(ctx); err != nil {
		return false, err
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
		  and known.size_bytes = e.size_bytes and known.modified_at = e.modified_at and known.changed_at = e.changed_at`,
		p.ID, sc.Volume.ID, p.PhysicalFileID, p.Size, l.Modified, sc.ID, l.Changed)
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
