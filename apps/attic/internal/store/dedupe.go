package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

// KeptFolder is a folder whose copies dedupe keeps, such as the organised
// tree. An empty Path keeps the whole volume.
type KeptFolder struct {
	VolumeID string
	Path     string
}

// DedupeGroup is one content with at least one present copy inside the kept
// folders and at least one outside them.
type DedupeGroup struct {
	ContentID int64       `json:"-"`
	Digest    disk.Digest `json:"-"`
	Ref       string      `json:"ref"`
	Size      int64       `json:"size"`
	Kept      []Hit       `json:"kept"`
	Extra     []Hit       `json:"extra"`
}

// DedupePlan finds hashed contents stored both inside and outside the kept
// folders, most bytes outside first. Copies already set aside are left out.
func (s *Store) DedupePlan(ctx context.Context, kept []KeptFolder, minSize int64, limit int) ([]DedupeGroup, error) {
	volumes, paths := make([]string, len(kept)), make([]string, len(kept))
	for i, k := range kept {
		volumes[i], paths[i] = k.VolumeID, k.Path
	}
	rows, err := s.pool.Query(ctx, `
		with places as (
			select e.id, e.content_id, exists (
				select 1 from unnest($1::uuid[], $2::text[]) as k(volume_id, path)
				where e.volume_id = k.volume_id and (k.path = '' or e.path = k.path or starts_with(e.path, k.path || '/'))
			) as kept
			from entries e
			where e.kind = 'file' and e.hash_state = 'done' and e.missing_scan is null and e.content_id is not null
			  and not exists (select 1 from dedupe_moves m where m.entry_id = e.id)
		), groups as (
			select p.content_id, row_number() over (order by sum(c.size_bytes) filter (where not p.kept) desc, p.content_id) as rank
			from places p join contents c on c.id = p.content_id
			where c.size_bytes >= $3
			group by p.content_id
			having bool_or(p.kept) and bool_or(not p.kept)
			order by rank limit $4
		)
		select `+hitColumns+`, p.kept, c.id, c.blake3
		from groups g join places p on p.content_id = g.content_id join entries e on e.id = p.id`+hitJoins+`
		order by g.rank, p.kept desc, v.label, e.path collate "C", e.id`, volumes, paths, minSize, limit)
	if err != nil {
		return nil, err
	}
	var groups []DedupeGroup
	_, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (struct{}, error) {
		var keptCopy bool
		var contentID int64
		var digest []byte
		h, err := scanHit(row, &keptCopy, &contentID, &digest)
		if err != nil {
			return struct{}{}, err
		}
		if len(groups) == 0 || groups[len(groups)-1].ContentID != contentID {
			if len(digest) != len(disk.Digest{}) {
				return struct{}{}, errors.New("invalid stored BLAKE3 digest")
			}
			g := DedupeGroup{ContentID: contentID, Ref: h.Ref, Size: h.Size}
			copy(g.Digest[:], digest)
			groups = append(groups, g)
		}
		g := &groups[len(groups)-1]
		if keptCopy {
			g.Kept = append(g.Kept, h)
		} else {
			g.Extra = append(g.Extra, h)
		}
		return struct{}{}, nil
	})
	return groups, err
}

// DedupeMove records that the copy at EntryID now lives at MovedTo, in its
// disk's quarantine folder, while KeptEntryID holds the same content.
type DedupeMove struct {
	EntryID     int64     `json:"-"`
	KeptEntryID int64     `json:"kept_entry_id"`
	ContentID   int64     `json:"-"`
	MovedTo     string    `json:"moved_to"`
	MovedAt     time.Time `json:"moved_at"`
}

func (s *Store) RecordDedupeMove(ctx context.Context, m DedupeMove) error {
	_, err := s.pool.Exec(ctx, `insert into dedupe_moves (entry_id, kept_entry_id, content_id, moved_to) values ($1, $2, $3, $4)
		on conflict (entry_id) do update set kept_entry_id = excluded.kept_entry_id, content_id = excluded.content_id,
		moved_to = excluded.moved_to, moved_at = now()`, m.EntryID, m.KeptEntryID, m.ContentID, m.MovedTo)
	return err
}

func (s *Store) dedupeMove(ctx context.Context, entryID int64) (*DedupeMove, error) {
	m := DedupeMove{EntryID: entryID}
	err := s.pool.QueryRow(ctx, `select kept_entry_id, content_id, moved_to, moved_at from dedupe_moves where entry_id = $1`, entryID).
		Scan(&m.KeptEntryID, &m.ContentID, &m.MovedTo, &m.MovedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &m, err
}
