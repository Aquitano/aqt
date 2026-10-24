package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/jackc/pgx/v5"
)

type Retrieval struct {
	Ref    string
	Digest disk.Digest
	Size   int64
	Places []Hit
}

func (s *Store) Retrieval(ctx context.Context, entryID int64, ref string) (Retrieval, error) {
	var result Retrieval
	lookup, err := s.newContentLookup(ctx, entryID, ref)
	if err != nil {
		return result, err
	}
	var contentID int64
	var digest []byte
	err = s.pool.QueryRow(ctx, `select c.id, c.blake3, c.size_bytes, `+refSQL+`
		from contents c where `+contentLookupWhere+`
		and ($1::bigint = 0 or exists (select 1 from entries where id = $1 and kind = 'file' and hash_state = 'done'))`,
		lookup.entryID, lookup.contentID).Scan(&contentID, &digest, &result.Size, &result.Ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, fmt.Errorf("get needs a hashed ordinary file: %w", ErrNotFound)
	}
	if err != nil {
		return result, err
	}
	if len(digest) != len(result.Digest) {
		return result, errors.New("invalid stored BLAKE3 digest")
	}
	copy(result.Digest[:], digest)
	rows, err := s.pool.Query(ctx, `select `+hitColumns+hitFrom+`
		where e.content_id = $1 and e.kind = 'file' and e.hash_state = 'done'
		order by e.id <> $2, e.missing_scan is not null, v.label, e.path collate "C", e.id`, contentID, entryID)
	if err != nil {
		return result, err
	}
	result.Places, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (Hit, error) { return scanHit(row) })
	return result, err
}

// MatchMountedVolume applies scan identity rules without updating the catalogue.
func MatchMountedVolume(fp disk.Fingerprint, known []Volume) *Volume {
	var candidates []Volume
	for _, v := range known {
		if v.FS == fp.FS && v.Serial == fp.Serial {
			candidates = append(candidates, v)
		}
	}
	v, _ := chooseVolume(fp, candidates)
	return v
}
