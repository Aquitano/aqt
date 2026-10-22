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
	lookup, err := newContentLookup(entryID, ref)
	if err != nil {
		return result, err
	}
	rows, err := s.pool.Query(ctx, `select c.id, c.blake3, c.size_bytes, `+refSQL+`
		from contents c where `+contentLookupWhere+`
		and ($1::bigint = 0 or exists (select 1 from entries where id = $1 and kind = 'file' and hash_state = 'done'))
		order by c.id limit 2`, lookup.entryID, lookup.prefix)
	if err != nil {
		return result, err
	}
	type content struct {
		id     int64
		digest []byte
		size   int64
		ref    string
	}
	found, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (content, error) {
		var c content
		err := row.Scan(&c.id, &c.digest, &c.size, &c.ref)
		return c, err
	})
	if err != nil {
		return result, err
	}
	if len(found) == 0 {
		return result, fmt.Errorf("get needs a hashed ordinary file: %w", ErrNotFound)
	}
	if len(found) != 1 {
		return result, errors.New("ambiguous content ref; use an entry ID")
	}
	c := found[0]
	if len(c.digest) != len(result.Digest) {
		return result, errors.New("invalid stored BLAKE3 digest")
	}
	copy(result.Digest[:], c.digest)
	result.Ref, result.Size = c.ref, c.size
	rows, err = s.pool.Query(ctx, `select `+hitColumns+hitFrom+`
		where e.content_id = $1 and e.kind = 'file' and e.hash_state = 'done'
		order by e.id <> $2, e.missing_scan is not null, v.label, e.path collate "C", e.id`, c.id, entryID)
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
