package store

import (
	"context"
	"errors"
)

type VerifyFile struct {
	ID        int64
	Path      string
	Kind      string
	HashState string
	Missing   bool
	Digest    []byte
}

// WalkVerification streams one statement's catalogue snapshot, including missing
// and unhashed entries. It never selects a substitute copy by content identity.
func (s *Store) WalkVerification(ctx context.Context, volumeID, under string, visit func(VerifyFile) error) error {
	if volumeID == "" {
		return errors.New("verification needs a selected volume")
	}
	rows, err := s.pool.Query(ctx, `select e.id, e.path, e.kind, e.hash_state,
		e.missing_scan is not null, c.blake3
		from entries e left join contents c on c.id = e.content_id
		where e.volume_id = $1 and e.kind <> 'dir'
		and ($2 = '' or e.path = $2 or (e.path collate "C" > $2 || '/' and e.path collate "C" < $2 || '0'))
		order by e.path collate "C", e.id`, volumeID, under)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var f VerifyFile
		if err := rows.Scan(&f.ID, &f.Path, &f.Kind, &f.HashState, &f.Missing, &f.Digest); err != nil {
			return err
		}
		if err := visit(f); err != nil {
			return err
		}
	}
	return rows.Err()
}
