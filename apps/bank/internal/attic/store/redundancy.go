package store

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/page"
)

type RedundancyOptions struct {
	VolumeID string
	Under    string
	Limit    int
	Offset   int
}

type RedundancyLocation struct {
	Hit
	UpdatedScan int64     `json:"updated_scan"`
	Updated     time.Time `json:"updated"`
}

type RedundancyContent struct {
	ID        int64                `json:"content_id"`
	BLAKE3    string               `json:"blake3"`
	Size      int64                `json:"size"`
	Volumes   int64                `json:"volumes"`
	Copies    int64                `json:"copies"`
	Locations []RedundancyLocation `json:"locations"`
}

type RedundancyReport struct {
	Contents          int64                `json:"contents"`
	Bytes             int64                `json:"bytes"`
	SingleVolume      int64                `json:"single_volume"`
	SingleVolumeBytes int64                `json:"single_volume_bytes"`
	UnknownFiles      int64                `json:"unknown_files"`
	UnknownBytes      int64                `json:"unknown_bytes"`
	Limit             int                  `json:"limit"`
	Offset            int                  `json:"offset"`
	LocationLimit     int                  `json:"location_limit"`
	Content           []RedundancyContent  `json:"content"`
	Unknown           []RedundancyLocation `json:"unknown"`
}

func (s *Store) Redundancy(ctx context.Context, o RedundancyOptions) (RedundancyReport, error) {
	r := RedundancyReport{Limit: o.Limit, Offset: o.Offset, LocationLimit: 100,
		Content: []RedundancyContent{}, Unknown: []RedundancyLocation{}}
	if err := page.Check(o.Limit, o.Offset); err != nil {
		return r, err
	}
	if o.Under != "" && o.VolumeID == "" {
		return r, fail.Invalidf("--under needs a volume")
	}
	q := &search{}
	where := append([]string{"e.kind = 'file'", "e.missing_scan is null"},
		q.entryFilters(copiesOf(SearchOptions{VolumeID: o.VolumeID, Under: o.Under}, true))...)
	cte := `with selected as (select e.id, case when e.hash_state = 'done' then e.content_id end as content_id,
 e.size_bytes from entries e where ` + strings.Join(where, " and ") + `),
 held as (select c.id, c.blake3, c.size_bytes, count(distinct e.volume_id) as volumes, count(*) as copies
 from contents c join entries e on e.content_id = c.id
 where c.id in (select content_id from selected) and e.kind = 'file' and e.missing_scan is null and e.hash_state = 'done'
 group by c.id) `
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return r, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, cte+`select count(*), coalesce(sum(size_bytes),0),
 count(*) filter (where volumes < 2), coalesce(sum(size_bytes) filter (where volumes < 2),0),
 (select count(*) from selected where content_id is null),
 (select coalesce(sum(size_bytes),0) from selected where content_id is null) from held`, q.args...).
		Scan(&r.Contents, &r.Bytes, &r.SingleVolume, &r.SingleVolumeBytes, &r.UnknownFiles, &r.UnknownBytes)
	if err != nil {
		return r, err
	}
	page := ` limit ` + q.next(o.Limit) + ` offset ` + q.next(o.Offset)
	rows, err := tx.Query(ctx, cte+`select id, encode(blake3,'hex'), size_bytes, volumes, copies
 from held where volumes < 2 order by size_bytes desc, id`+page, q.args...)
	if err != nil {
		return r, err
	}
	r.Content, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (RedundancyContent, error) {
		var c RedundancyContent
		err := row.Scan(&c.ID, &c.BLAKE3, &c.Size, &c.Volumes, &c.Copies)
		return c, err
	})
	if err != nil {
		return r, err
	}
	if len(r.Content) > 0 {
		ids := make([]int64, len(r.Content))
		for i := range r.Content {
			ids[i] = r.Content[i].ID
			r.Content[i].Locations = []RedundancyLocation{}
		}
		rows, err := tx.Query(ctx, `select places.*, selected.ordinality
 from unnest($1::bigint[]) with ordinality selected(content_id, ordinality)
 cross join lateral (select `+hitColumns+`, e.updated_scan, sc.started_at`+hitFrom+`
 join scans sc on sc.id = e.updated_scan
 where e.content_id = selected.content_id and e.kind = 'file' and e.missing_scan is null and e.hash_state = 'done'
 order by e.volume_id, e.path collate "C", e.id limit $2) places
 order by selected.ordinality, places.volume_id, places.path collate "C", places.id`, ids, r.LocationLimit)
		if err != nil {
			return r, err
		}
		for rows.Next() {
			var l RedundancyLocation
			var position int64
			h, err := scanHit(rows, &l.UpdatedScan, &l.Updated, &position)
			if err != nil {
				rows.Close()
				return r, err
			}
			l.Hit = h
			r.Content[position-1].Locations = append(r.Content[position-1].Locations, l)
		}
		if err := rows.Err(); err != nil {
			return r, err
		}
	}
	rows, err = tx.Query(ctx, cte+`select `+hitColumns+`, e.updated_scan, sc.started_at`+hitFrom+`
 join scans sc on sc.id = e.updated_scan where e.id in (select id from selected where content_id is null)
 order by e.size_bytes desc, e.id`+page, q.args...)
	if err != nil {
		return r, err
	}
	r.Unknown, err = pgx.CollectRows(rows, scanRedundancyLocation)
	if err != nil {
		return r, err
	}
	for i := range r.Unknown {
		r.Unknown[i].Ref = ""
	}
	return r, tx.Commit(ctx)
}

func scanRedundancyLocation(row pgx.CollectableRow) (RedundancyLocation, error) {
	var l RedundancyLocation
	h, err := scanHit(row, &l.UpdatedScan, &l.Updated)
	l.Hit = h
	return l, err
}
