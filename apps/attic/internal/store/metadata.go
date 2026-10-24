package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/metadata"
	"github.com/jackc/pgx/v5"
)

// ContentFile identifies a catalogued copy and the bytes its derived results belong to.
type ContentFile struct {
	ID        int64
	Path      string
	ContentID int64
	Size      int64
	Digest    disk.Digest
	VolumeID  string
	Ref       string
}

const pendingMetadata = `from entries e join contents c on c.id = e.content_id
 where e.volume_id = $1 and e.kind = 'file' and e.hash_state = 'done' and e.missing_scan is null
 and e.ext = any($2) and not exists (select 1 from metadata m where m.content_id = c.id)
 and ($3 = '' or e.path collate "C" < $3)`

func (sc *Scan) MetadataTotals(ctx context.Context) (int64, error) {
	lower, upper := sc.subtree()
	var n int64
	err := sc.store.pool.QueryRow(ctx, `select count(distinct c.id) `+pendingMetadata+` and e.path collate "C" > $4`, sc.Volume.ID, metadata.Extensions, upper, lower).Scan(&n)
	return n, err
}

func (sc *Scan) NextMetadata(ctx context.Context, after ContentFile, limit int) ([]ContentFile, error) {
	lower, upper := sc.subtree()
	if after.ID != 0 {
		lower = after.Path
	}
	rows, err := sc.store.pool.Query(ctx, `select e.id, e.path, c.id, c.size_bytes, c.blake3 `+pendingMetadata+`
 and (e.path collate "C", e.id) > ($4, $5) order by e.path collate "C", e.id limit $6`, sc.Volume.ID, metadata.Extensions, upper, lower, after.ID, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ContentFile, error) {
		var p ContentFile
		var digest []byte
		err := row.Scan(&p.ID, &p.Path, &p.ContentID, &p.Size, &digest)
		copy(p.Digest[:], digest)
		return p, err
	})
}

// MetadataDetail holds only embedded tags; path-dependent information lives on entries.
type MetadataDetail struct {
	Ref string `json:"ref"`
	metadata.Result
	Extracted time.Time `json:"extracted"`
}

func (sc *Scan) SetMetadata(ctx context.Context, contentID int64, result metadata.Result) error {
	tags := cleanJSON(result.Tags)
	data, err := json.Marshal(tags)
	if err != nil {
		return err
	}
	var lines []string
	if result.Status == "ok" {
		for _, key := range slices.Sorted(maps.Keys(result.Tags)) {
			if strings.HasPrefix(key, "ExifTool:") {
				continue
			}
			lines = append(lines, key+": "+fmt.Sprint(cleanJSON(result.Tags[key])))
		}
	}
	tag, err := sc.store.pool.Exec(ctx, `insert into metadata (content_id, status, detail, tags, text) values ($1, $2, $3, $4, $5) on conflict do nothing`, contentID, result.Status, cleanText(result.Detail), data, cleanText(strings.Join(lines, "\n")))
	if err == nil && tag.RowsAffected() > 0 {
		sc.Counts.Metadata++
	}
	return err
}

func cleanJSON(v any) any {
	switch v := v.(type) {
	case string:
		return cleanText(v)
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, value := range v {
			out[cleanText(key)] = cleanJSON(value)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, value := range v {
			out[i] = cleanJSON(value)
		}
		return out
	default:
		return v
	}
}

func (s *Store) Metadata(ctx context.Context, entryID int64, ref string) (MetadataDetail, error) {
	var d MetadataDetail
	lookup, err := s.newContentLookup(ctx, entryID, ref)
	if err != nil {
		return d, err
	}
	err = s.pool.QueryRow(ctx, `select `+refSQL+`, m.status, m.detail, m.tags, m.extracted_at
 from metadata m join contents c on c.id = m.content_id
 where `+contentLookupWhere, lookup.entryID, lookup.contentID).
		Scan(&d.Ref, &d.Status, &d.Detail, &d.Tags, &d.Extracted)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, fmt.Errorf("no metadata read for that file: %w", ErrNotFound)
	}
	return d, err
}

func (s *Store) SearchMetadata(ctx context.Context, o SearchOptions) ([]TextHit, error) {
	return s.searchTextTable(ctx, o, "metadata")
}
