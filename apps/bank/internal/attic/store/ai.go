package store

import (
	"context"
	"errors"
	"html"
	"slices"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/ai"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/jackc/pgx/v5"
)

// AISelection is the files an enrichment run may read: on these volumes,
// below Under, among Entries or Refs when either is given, with one of the
// Extensions the provider reads.
type AISelection struct {
	Volumes    []string      `json:"volumes" doc:"IDs of the volumes attached to the worker's machine."`
	Under      string        `json:"under,omitempty" doc:"Volume-relative folder on the selected volumes."`
	Entries    []int64       `json:"entries,omitempty"`
	Refs       []ref.Content `json:"refs,omitempty"`
	Extensions []string      `json:"extensions"`
	Key        ai.Key        `json:"key"`
	Force      bool          `json:"force,omitempty" doc:"Select contents that already have a result under this key."`
	Retry      bool          `json:"retry,omitempty" doc:"Select contents whose earlier attempt failed, instead of new ones."`
	contents   []int64
}

// ResolveRefs looks up the selection's refs once, so paging through its
// candidates does not query them again.
func (s *Store) ResolveRefs(ctx context.Context, o AISelection) (AISelection, error) {
	contents := slices.Clone(o.contents)
	for _, cited := range o.Refs {
		lookup, err := s.newContentLookup(ctx, 0, cited)
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

// AILease is how long a claim holds without being renewed. A worker renews
// it well before then while its provider runs, so a lease that runs out means
// the worker died or lost its connection, and the work is free again.
const AILease = 2 * time.Minute

// ErrClaimLost means a lease is no longer the current one: it ran out and
// another worker claimed the work, or the result was saved already.
var ErrClaimLost = errors.New("this claim's lease ran out and the work went to another worker")

// AIClaim is a lease on one content's work under one policy.
type AIClaim struct {
	Lease   string    `json:"lease" doc:"Send it to renew, release or save the work."`
	Expires time.Time `json:"expires_at" doc:"When another worker may claim the work, unless the lease is renewed first."`
}

// ClaimAI leases the work on contentID under key. It returns nil when the
// work is complete, unless force, or another worker holds a lease that has
// not run out.
func (s *Store) ClaimAI(ctx context.Context, contentID int64, key ai.Key, force bool) (*AIClaim, error) {
	var c AIClaim
	err := s.pool.QueryRow(ctx, `insert into ai_claims (content_id, task, provider, model, prompt_version, lease, expires_at)
 select $1, $2, $3, $4, $5, gen_random_uuid(), now() + make_interval(secs => $7)
 where exists (select 1 from contents where id = $1)
 and ($6 or not exists (select 1 from ai_results where content_id = $1 and task = $2 and provider = $3 and model = $4
  and prompt_version = $5 and status <> 'failed'))
 on conflict (content_id, task, provider, model, prompt_version) do update
 set lease = excluded.lease, expires_at = excluded.expires_at
 where ai_claims.expires_at <= now()
 returning lease::text, expires_at`, contentID, key.Task, key.Provider, key.Model, key.PromptVersion, force, AILease.Seconds()).
		Scan(&c.Lease, &c.Expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// RenewAI extends a lease its holder still holds.
func (s *Store) RenewAI(ctx context.Context, lease string) (AIClaim, error) {
	c := AIClaim{Lease: lease}
	err := s.pool.QueryRow(ctx, `update ai_claims set expires_at = now() + make_interval(secs => $2)
 where lease::text = $1 returning expires_at`, lease, AILease.Seconds()).Scan(&c.Expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrClaimLost
	}
	return c, err
}

// ReleaseAI gives up a lease without a result. Releasing a lease that is no
// longer current changes nothing.
func (s *Store) ReleaseAI(ctx context.Context, lease string) error {
	_, err := s.pool.Exec(ctx, `delete from ai_claims where lease::text = $1`, lease)
	return err
}

// AIOutcome is what a provider made of one content.
type AIOutcome struct {
	ai.Result
	Failure   string `json:"failure,omitempty" doc:"Why the provider failed. The content is retried by a later run."`
	ElapsedMS int64  `json:"elapsed_ms" minimum:"0"`
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

// SaveAI stores the outcome of the work lease holds and ends the lease. A
// lease that is no longer current saves nothing and answers ErrClaimLost, so
// a worker that outlived its lease cannot overwrite the next worker's answer.
// Retries update their own policy row; a failed forced run preserves an
// earlier usable answer. A changed model or prompt always gets a separate row.
func (s *Store) SaveAI(ctx context.Context, lease string, o AIOutcome) error {
	status, detail, result := "ok", "", o.Result
	switch {
	case o.Failure != "":
		status, detail = "failed", o.Failure
		result = ai.Result{}
	case result.Truncated:
		status = "truncated"
	case result.Text == "":
		status = "empty"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var contentID int64
	var key ai.Key
	err = tx.QueryRow(ctx, `delete from ai_claims where lease::text = $1
 returning content_id, task, provider, model, prompt_version`, lease).
		Scan(&contentID, &key.Task, &key.Provider, &key.Model, &key.PromptVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrClaimLost
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `insert into ai_results (content_id,task,provider,model,prompt_version,status,text,detail,reported_model,elapsed_ms)
 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
 on conflict (content_id,task,provider,model,prompt_version) do update set
 status=excluded.status,text=excluded.text,detail=excluded.detail,reported_model=excluded.reported_model,
 elapsed_ms=excluded.elapsed_ms,attempts=ai_results.attempts+1,updated_at=now()
 where ai_results.status='failed' or excluded.status<>'failed'`, contentID, key.Task, key.Provider, key.Model, key.PromptVersion, status, CleanText(result.Text), CleanText(detail), CleanText(result.ReportedModel), o.ElapsedMS); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) Analyses(ctx context.Context, entryID int64, cited ref.Content) ([]Analysis, error) {
	lookup, err := s.newContentLookup(ctx, entryID, cited)
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
	q, err := s.newTextSearch(o, "a.id", "a.content_id")
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
