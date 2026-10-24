package store

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AISelection struct {
	Volumes    []string
	Under      string
	Entries    []int64
	Refs       []string
	Extensions []string
	Key        ai.Key
	Force      bool
	Retry      bool
	contents   []int64
}

// ResolveRefs looks up the selection's refs once, so paging through its
// candidates does not query them again.
func (s *Store) ResolveRefs(ctx context.Context, o AISelection) (AISelection, error) {
	contents := slices.Clone(o.contents)
	for _, ref := range o.Refs {
		lookup, err := s.newContentLookup(ctx, 0, ref)
		if err != nil {
			return o, err
		}
		contents = append(contents, lookup.contentID)
	}
	o.Refs, o.contents = nil, contents
	return o, nil
}

// aiCandidates keeps ref-only selections on the content key. Combining entry
// and ref predicates with OR across the join prevents that index lookup.
func (s *Store) aiCandidates(ctx context.Context, o AISelection, after int64) (string, []any, error) {
	o, err := s.ResolveRefs(ctx, o)
	if err != nil {
		return "", nil, err
	}
	contents := o.contents
	q := &search{args: []any{after, o.Volumes, o.Extensions, strings.TrimSuffix(o.Under, "/"), o.Key.Task, o.Key.Provider, o.Key.Model, o.Key.PromptVersion, o.Force}}
	sql := ` from entries e join contents c on c.id=e.content_id
 left join ai_results a on a.content_id=c.id and a.task=$5 and a.provider=$6 and a.model=$7 and a.prompt_version=$8
 where e.id > $1 and e.volume_id=any($2::uuid[]) and e.kind='file' and e.hash_state='done' and e.missing_scan is null
 and e.ext=any($3) and ($4='' or (e.path collate "C" > $4 || '/' and e.path collate "C" < $4 || '0'))
 and ($5 <> 'ocr' or e.ext <> 'pdf' or exists (select 1 from texts t where t.content_id=c.id and t.status='needs_ocr'))
 and ($9 or a.id is null or a.status='failed')`
	switch {
	case len(o.Entries) > 0 && len(contents) > 0:
		sql += ` and e.id in (select unnest(` + q.next(o.Entries) + `::bigint[]) union
 select pe.id from entries pe where pe.content_id=any(` + q.next(contents) + `::bigint[]))`
	case len(o.Entries) > 0:
		sql += ` and e.id=any(` + q.next(o.Entries) + `::bigint[])`
	case len(contents) > 0:
		sql += ` and c.id=any(` + q.next(contents) + `::bigint[])`
	}
	return sql, q.args, nil
}

// AIVolumes preflights all selected source disks before creating scratch files.
func (s *Store) AIVolumes(ctx context.Context, o AISelection) ([]string, error) {
	sql, args, err := s.aiCandidates(ctx, o, 0)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select distinct e.volume_id::text `+sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (s *Store) NextAI(ctx context.Context, o AISelection, after int64, limit int) ([]ContentFile, error) {
	sql, args, err := s.aiCandidates(ctx, o, after)
	if err != nil {
		return nil, err
	}
	q := &search{args: args}
	retryParam, limitParam := q.next(o.Retry), q.next(limit)
	rows, err := s.pool.Query(ctx, `select e.id,e.path,e.volume_id::text,c.id,c.size_bytes,c.blake3,`+refSQL+sql+
		` and ($9 or (not `+retryParam+` and a.id is null) or (`+retryParam+` and a.status='failed'))
 order by e.id limit `+limitParam, q.args...)

	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ContentFile, error) {
		var p ContentFile
		var hash []byte
		err := row.Scan(&p.ID, &p.Path, &p.VolumeID, &p.ContentID, &p.Size, &hash, &p.Ref)
		copy(p.Digest[:], hash)
		return p, err
	})
}

// AIClaim holds the content-policy lock and saves through the same connection.
// No transaction stays open while an external provider runs.
type AIClaim struct {
	conn      *pgxpool.Conn
	contentID int64
	key       ai.Key
	release   func()
}

func (c *AIClaim) Close() { c.release() }

// ClaimAI returns nil for work already complete or claimed by another runner.
func (s *Store) ClaimAI(ctx context.Context, contentID int64, key ai.Key, force bool) (*AIClaim, error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(key)
	lockKey := fmt.Sprintf("attic-ai:%d:%s", contentID, encoded)
	var locked bool
	if err := conn.QueryRow(ctx, `select pg_try_advisory_lock(hashtextextended($1,0))`, lockKey).Scan(&locked); err != nil {
		conn.Release()
		return nil, err
	}
	if !locked {
		conn.Release()
		return nil, nil
	}
	release := func() {
		timeout, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(timeout, `select pg_advisory_unlock(hashtextextended($1,0))`, lockKey); err != nil {
			_ = conn.Conn().Close(timeout)
		}
		conn.Release()
	}
	if !force {
		var done bool
		err := conn.QueryRow(ctx, `select exists(select 1 from ai_results where content_id=$1 and task=$2 and provider=$3 and model=$4 and prompt_version=$5 and status<>'failed')`, contentID, key.Task, key.Provider, key.Model, key.PromptVersion).Scan(&done)
		if err != nil || done {
			release()
			return nil, err
		}
	}
	return &AIClaim{conn: conn, contentID: contentID, key: key, release: release}, nil
}

type Analysis struct {
	ID  int64  `json:"id"`
	Ref string `json:"ref"`
	ai.Key
	ai.Result
	Status    string    `json:"status"`
	Detail    string    `json:"detail,omitempty"`
	ElapsedMS int64     `json:"elapsed_ms"`
	Attempts  int64     `json:"attempts"`
	Updated   time.Time `json:"updated"`
}

// Save retries update their own policy row; a failed forced run preserves an
// earlier usable answer. A changed model or prompt always gets a separate row.
func (c *AIClaim) Save(ctx context.Context, result ai.Result, failure error, elapsed time.Duration) error {
	contentID, key := c.contentID, c.key
	status, detail := "ok", ""
	switch {
	case failure != nil:
		status, detail = "failed", failure.Error()
		result = ai.Result{}
	case result.Truncated:
		status = "truncated"
	case result.Text == "":
		status = "empty"
	}
	_, err := c.conn.Exec(ctx, `insert into ai_results (content_id,task,provider,model,prompt_version,status,text,detail,reported_model,elapsed_ms)
 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
 on conflict (content_id,task,provider,model,prompt_version) do update set
 status=excluded.status,text=excluded.text,detail=excluded.detail,reported_model=excluded.reported_model,
 elapsed_ms=excluded.elapsed_ms,attempts=ai_results.attempts+1,updated_at=now()
 where ai_results.status='failed' or excluded.status<>'failed'`, contentID, key.Task, key.Provider, key.Model, key.PromptVersion, status, cleanText(result.Text), cleanText(detail), cleanText(result.ReportedModel), elapsed.Milliseconds())
	return err
}

func (s *Store) Analyses(ctx context.Context, entryID int64, ref string) ([]Analysis, error) {
	lookup, err := s.newContentLookup(ctx, entryID, ref)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `select a.id,`+refSQL+`,a.task,a.provider,a.model,a.prompt_version,a.status,a.text,a.detail,a.reported_model,a.elapsed_ms,a.attempts,a.updated_at
 from ai_results a join contents c on c.id=a.content_id
 where `+contentLookupWhere+` order by a.updated_at desc,a.id desc`, lookup.entryID, lookup.contentID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Analysis, error) {
		var a Analysis
		err := row.Scan(&a.ID, &a.Ref, &a.Task, &a.Provider, &a.Model, &a.PromptVersion, &a.Status, &a.Text, &a.Detail, &a.ReportedModel, &a.ElapsedMS, &a.Attempts, &a.Updated)
		a.Truncated = a.Status == "truncated"
		return a, err
	})
}

func (s *Store) SearchAI(ctx context.Context, o SearchOptions) ([]AIHit, error) {
	q, err := s.newTextSearch(ctx, o, "a.id", "a.content_id")
	if err != nil || q == nil {
		return nil, err
	}
	q.where = append(q.where, "a.status in ('ok','truncated')")
	rows, err := s.pool.Query(ctx, `select a.content_id,`+refSQL+`,a.task,a.provider,a.model,a.prompt_version,paradedb.score(a.id),
 paradedb.snippet(a.text,start_tag => '',end_tag => '',max_num_chars => 200)
 from ai_results a join contents c on c.id=a.content_id`+q.tail(o), q.args...)
	if err != nil {
		return nil, err
	}
	var ids []int64
	hits, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (AIHit, error) {
		var h AIHit
		var id int64
		var score float32
		var snippet *string
		err := row.Scan(&id, &h.Ref, &h.Task, &h.Provider, &h.Model, &h.PromptVersion, &score, &snippet)
		h.Score = float64(score)
		if snippet != nil {
			h.Snippet = html.UnescapeString(*snippet)
		}
		ids = append(ids, id)
		return h, err
	})
	if err != nil {
		return nil, err
	}
	places, err := s.occurrencesMany(ctx, ids, 0, false, copiesOf(o, false))
	if err != nil {
		return nil, err
	}
	for i, id := range ids {
		hits[i].Places = places[id]
	}
	return hits, nil
}

type AIHit struct {
	TextHit
	ai.Key
}

func (s *Store) AITotals(ctx context.Context) (map[string]int64, error) {
	rows, err := s.pool.Query(ctx, `select a.task||':'||a.status,count(*) from ai_results a where exists(select 1 from entries e where e.content_id=a.content_id and e.missing_scan is null) group by a.task,a.status`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	totals := map[string]int64{}
	for rows.Next() {
		var key string
		var n int64
		if err := rows.Scan(&key, &n); err != nil {
			return nil, err
		}
		totals[key] = n
	}
	return totals, rows.Err()
}
