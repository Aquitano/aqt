package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/page"
)

// VerifyFile is a catalogued file or link with the full digest its bytes had
// when they were hashed.
type VerifyFile struct {
	ID        int64          `json:"id"`
	Path      string         `json:"path"`
	Kind      string         `json:"kind" enum:"file,link"`
	HashState string         `json:"hash_state" doc:"done when the digest is known."`
	Missing   bool           `json:"missing,omitempty"`
	Digest    content.Digest `json:"blake3,omitzero" doc:"The full BLAKE3 digest, absent until the file is hashed."`
}

func (s *Store) ResolveVerificationPath(ctx context.Context, volumeID, under string) (string, error) {
	if volumeID == "" {
		return "", errors.New("verification needs a selected volume")
	}
	parent := ""
	for _, name := range strings.Split(strings.TrimPrefix(under, "/"), "/") {
		if name == "" {
			return under, nil
		}
		exact := parent + "/" + name
		rows, err := s.pool.Query(ctx, `select e.path
			from entries e join entries p on p.id = e.parent_id
			where p.volume_id = $1 and p.path collate "C" = $2
			and e.volume_id = $1 and lower(e.name) = lower($3)
			group by e.path order by (e.path = $4) desc, e.path collate "C" limit 2`, volumeID, parent, name, exact)
		if err != nil {
			return "", err
		}
		paths, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return "", err
		}
		if len(paths) == 0 {
			return under, nil
		}
		if len(paths) > 1 && paths[0] != exact {
			return "", fmt.Errorf("verification scope %q matches multiple catalogue paths; use exact spelling", under)
		}
		parent = paths[0]
	}
	return parent, nil
}

// VerifyFiles lists the entries below under on a volume, missing and unhashed
// ones included, in path order after the entry at after, and never a substitute
// copy by content identity. The first page starts at the zero VerifyFile.
func (s *Store) VerifyFiles(ctx context.Context, volumeID, under string, after VerifyFile, limit int) ([]VerifyFile, error) {
	if volumeID == "" {
		return nil, errors.New("verification needs a selected volume")
	}
	if err := page.Check(limit, 0); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select e.id, e.path, e.kind, e.hash_state,
		e.missing_scan is not null, c.blake3
		from entries e left join contents c on c.id = e.content_id
		where e.volume_id = $1::uuid and e.kind <> 'dir'
		and ($2 = '' or e.path = $2 or (e.path collate "C" > $2 || '/' and e.path collate "C" < $2 || '0'))
		and (e.path collate "C", e.id) > ($3::text collate "C", $4::bigint)
		order by e.path collate "C", e.id limit $5`, volumeID, under, after.Path, after.ID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (VerifyFile, error) {
		var f VerifyFile
		err := row.Scan(&f.ID, &f.Path, &f.Kind, &f.HashState, &f.Missing, &f.Digest)
		return f, err
	})
}
