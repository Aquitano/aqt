package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

const (
	MaxAttempts     = 5
	staleRunningAge = "2 minutes"
	// retryBackoff is the wait after the first failed attempt; it doubles with
	// each attempt after that.
	retryBackoff   = "1 minute"
	ClassAbandoned = "abandoned"
)

type DerivationKey struct {
	RawHash   []byte
	Extractor string
	Version   int
}

// ClaimDerivation takes the oldest pending job whose retry is due, or a
// running one whose worker went quiet, and marks it running under this worker. A quiet job that has
// used up its attempts is failed as abandoned instead: whatever keeps killing
// its worker would kill the next one too. ok is false when the queue is empty.
func (s *Store) ClaimDerivation(ctx context.Context) (d Derivation, ok bool, err error) {
	err = s.db.NewRaw(`with abandoned as (
			update derivations set status = 'failed', error_class = ?, updated_at = now(),
				last_error = 'claimed ' || attempts || ' times without finishing'
			where status = 'running' and claimed_at < now() - interval '`+staleRunningAge+`' and attempts >= ?
		)
		update derivations set status = 'running', claimed_at = now(), attempts = attempts + 1, updated_at = now()
		where (raw_hash, extractor, extractor_version) in (
			select raw_hash, extractor, extractor_version from derivations
			where (status = 'pending' and (retry_at is null or retry_at <= now()))
				or (status = 'running' and claimed_at < now() - interval '`+staleRunningAge+`' and attempts < ?)
			order by created_at limit 1 for update skip locked)
		returning *`, ClassAbandoned, MaxAttempts, MaxAttempts).Scan(ctx, &d)
	if errors.Is(err, sql.ErrNoRows) {
		return Derivation{}, false, nil
	}
	if err != nil {
		return Derivation{}, false, err
	}
	return d, true, nil
}

func (s *Store) LoadBlob(ctx context.Context, hash []byte) (RawHTMLBlob, error) {
	var b RawHTMLBlob
	err := s.db.NewSelect().Model(&b).Where("hash = ?", hash).Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return RawHTMLBlob{}, ErrNotFound
	}
	return b, err
}

// CaptureSummary is what the source tables say about one blob: the URL it
// was first captured at and the window it was seen in. Records take their
// first/last_seen_at from here, so a rebuild reproduces them.
type CaptureSummary struct {
	URL       string
	FirstSeen time.Time
	LastSeen  time.Time
}

func (s *Store) SummarizeCaptures(ctx context.Context, hash []byte) (CaptureSummary, error) {
	var c CaptureSummary
	err := s.db.NewRaw(`select (array_agg(url order by captured_at, id))[1] as url,
			min(captured_at) as first_seen, max(captured_at) as last_seen
		from captures where raw_hash = ?`, hash).Scan(ctx, &c.URL, &c.FirstSeen, &c.LastSeen)
	if err != nil {
		return CaptureSummary{}, err
	}
	if c.URL == "" {
		return CaptureSummary{}, ErrNotFound
	}
	return c, nil
}

type RecordInput struct {
	Record Record
	URL    URLKey
}

type RecordResult struct {
	ID           int64
	Deduplicated bool
}

// CompleteDerivation writes the record and closes the job in one short
// transaction. A page has one record per extractor, keyed by its canonical
// URL: its seen window always widens, and its content is replaced only by a
// blob seen at least as late, so replaying an older blob never overwrites a
// newer one. A job Forget deleted while its extractor ran writes nothing and
// returns ErrNotFound, since its record would bring back what was forgotten.
func (s *Store) CompleteDerivation(ctx context.Context, key DerivationKey, in RecordInput, processing time.Duration) (RecordResult, error) {
	var res RecordResult
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var held bool
		err := tx.NewRaw(`select true from derivations
			where raw_hash = ? and extractor = ? and extractor_version = ? for update`,
			key.RawHash, key.Extractor, key.Version).Scan(ctx, &held)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		urlID, err := upsertURL(ctx, tx, in.URL)
		if err != nil {
			return err
		}
		r := in.Record
		var inserted bool
		if err := tx.NewRaw(`insert into records (extractor, record_hash, url_id, canonical_url, title, search_text, data, first_seen_at, last_seen_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (extractor, canonical_url) do update set
				first_seen_at = least(records.first_seen_at, excluded.first_seen_at),
				last_seen_at = greatest(records.last_seen_at, excluded.last_seen_at),
				record_hash = case when excluded.last_seen_at >= records.last_seen_at then excluded.record_hash else records.record_hash end,
				url_id = case when excluded.last_seen_at >= records.last_seen_at then excluded.url_id else records.url_id end,
				title = case when excluded.last_seen_at >= records.last_seen_at then excluded.title else records.title end,
				search_text = case when excluded.last_seen_at >= records.last_seen_at then excluded.search_text else records.search_text end,
				data = case when excluded.last_seen_at >= records.last_seen_at then excluded.data else records.data end
			returning id, xmax = 0`,
			r.Extractor, r.RecordHash, urlID, r.CanonicalURL, nullable(r.Title), r.SearchText,
			string(r.Data), r.FirstSeenAt, r.LastSeenAt).Scan(ctx, &res.ID, &inserted); err != nil {
			return err
		}
		res.Deduplicated = !inserted
		_, err = tx.NewUpdate().Model((*Derivation)(nil)).
			Set("status = ?", StatusDone).Set("record_id = ?", res.ID).
			Set("processing_ms = ?", processing.Milliseconds()).
			Set("last_error = null").Set("error_class = null").Set("updated_at = now()").
			Where("raw_hash = ? and extractor = ? and extractor_version = ?", key.RawHash, key.Extractor, key.Version).
			Exec(ctx)
		return err
	})
	if err != nil {
		return RecordResult{}, err
	}
	return res, nil
}

type Failure struct {
	Error string
	Class string
	Retry bool
}

// FailDerivation records a failed attempt. A job to retry goes back to pending
// and is not claimed again before its backoff has passed.
func (s *Store) FailDerivation(ctx context.Context, key DerivationKey, f Failure) error {
	q := s.db.NewUpdate().Model((*Derivation)(nil)).
		Set("last_error = ?", f.Error).Set("error_class = ?", f.Class).Set("updated_at = now()").
		Where("raw_hash = ? and extractor = ? and extractor_version = ?", key.RawHash, key.Extractor, key.Version)
	if f.Retry {
		q = q.Set("status = ?", StatusPending).
			Set("retry_at = now() + interval '" + retryBackoff + "' * power(2, attempts - 1)")
	} else {
		q = q.Set("status = ?", StatusFailed)
	}
	_, err := q.Exec(ctx)
	return err
}

func (s *Store) QueueStats(ctx context.Context) (pending int64, oldest time.Duration, err error) {
	var seconds float64
	err = s.db.NewRaw(`select count(*), coalesce(extract(epoch from now() - min(created_at)), 0)
		from derivations where status in ('pending', 'running')`).Scan(ctx, &pending, &seconds)
	return pending, time.Duration(seconds * float64(time.Second)), err
}

type ExtractorVersion struct {
	Name    string
	Version int
}

type ReprocessOpts struct {
	Targets []ExtractorVersion
	Failed  bool
	All     bool
}

// Reprocess re-queues work. All wipes the derived rows of the targets and
// rebuilds the queue from captures alone; Failed resets failed jobs; otherwise
// every captured blob is queued under the target's current version, which is
// how a version bump is rolled out, and the older versions' jobs and the
// records only they produced go, so search never shows a page twice. Returns
// the number of queued jobs.
func (s *Store) Reprocess(ctx context.Context, o ReprocessOpts) (int64, error) {
	var queued int64
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		names := make([]string, 0, len(o.Targets))
		for _, t := range o.Targets {
			names = append(names, t.Name)
		}
		switch {
		case o.All:
			if _, err := tx.NewDelete().Model((*Derivation)(nil)).Where("extractor in (?)", bun.List(names)).Exec(ctx); err != nil {
				return err
			}
			if _, err := tx.NewDelete().Model((*Record)(nil)).Where("extractor in (?)", bun.List(names)).Exec(ctx); err != nil {
				return err
			}
		case o.Failed:
			r, err := tx.NewUpdate().Model((*Derivation)(nil)).
				Set("status = ?", StatusPending).Set("attempts = 0").Set("retry_at = null").Set("last_error = null").
				Set("error_class = null").Set("updated_at = now()").
				Where("status = ? and extractor in (?)", StatusFailed, bun.List(names)).Exec(ctx)
			if err != nil {
				return err
			}
			queued, _ = r.RowsAffected()
			return nil
		default:
			for _, t := range o.Targets {
				if _, err := tx.NewDelete().Model((*Derivation)(nil)).
					Where("extractor = ? and extractor_version <> ?", t.Name, t.Version).Exec(ctx); err != nil {
					return err
				}
				if _, err := tx.NewRaw(`delete from records r where r.extractor = ?
					and not exists (select 1 from derivations d where d.record_id = r.id)`, t.Name).Exec(ctx); err != nil {
					return err
				}
			}
		}
		var err error
		queued, err = queueCaptures(ctx, tx, o.Targets)
		return err
	})
	return queued, err
}

// QueueCaptures queues every captured blob under each target's version unless
// it already has a job there, so neither a version bump nor a migration that
// clears the derived tables waits on a manual reprocess. Returns the number
// of queued jobs.
func (s *Store) QueueCaptures(ctx context.Context, targets []ExtractorVersion) (int64, error) {
	return queueCaptures(ctx, s.db, targets)
}

func queueCaptures(ctx context.Context, db bun.IDB, targets []ExtractorVersion) (int64, error) {
	var queued int64
	for _, t := range targets {
		r, err := db.NewRaw(`insert into derivations (raw_hash, extractor, extractor_version)
			select distinct raw_hash, extractor, ? from captures where extractor = ?
			on conflict do nothing`, t.Version, t.Name).Exec(ctx)
		if err != nil {
			return 0, err
		}
		n, _ := r.RowsAffected()
		queued += n
	}
	return queued, nil
}

func nullable(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
