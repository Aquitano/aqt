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
	ClassAbandoned  = "abandoned"
)

type DerivationKey struct {
	RawHash   []byte
	Extractor string
	Version   int
}

// ClaimDerivation takes the oldest pending job, or a running one whose worker
// went quiet, and marks it running under this worker. A quiet job that has
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
			where status = 'pending' or (status = 'running' and claimed_at < now() - interval '`+staleRunningAge+`' and attempts < ?)
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
// transaction. A record with the same hash already on file is not rewritten;
// only its seen window widens.
func (s *Store) CompleteDerivation(ctx context.Context, key DerivationKey, in RecordInput, processing time.Duration) (RecordResult, error) {
	var res RecordResult
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		urlID, err := upsertURL(ctx, tx, in.URL)
		if err != nil {
			return err
		}
		r := in.Record
		var inserted bool
		if err := tx.NewRaw(`insert into records (extractor, record_hash, url_id, canonical_url, title, search_text, data, first_seen_at, last_seen_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (extractor, record_hash) do update set
				first_seen_at = least(records.first_seen_at, excluded.first_seen_at),
				last_seen_at = greatest(records.last_seen_at, excluded.last_seen_at)
			returning id, xmax = 0`,
			r.Extractor, r.RecordHash, urlID, nullable(r.CanonicalURL), nullable(r.Title), r.SearchText,
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

func (s *Store) FailDerivation(ctx context.Context, key DerivationKey, f Failure) error {
	status := StatusFailed
	if f.Retry {
		status = StatusPending
	}
	_, err := s.db.NewUpdate().Model((*Derivation)(nil)).
		Set("status = ?", status).Set("last_error = ?", f.Error).Set("error_class = ?", f.Class).
		Set("updated_at = now()").
		Where("raw_hash = ? and extractor = ? and extractor_version = ?", key.RawHash, key.Extractor, key.Version).
		Exec(ctx)
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
				Set("status = ?", StatusPending).Set("attempts = 0").Set("last_error = null").
				Set("error_class = null").Set("updated_at = now()").
				Where("status = ? and extractor in (?)", StatusFailed, bun.List(names)).Exec(ctx)
			if err != nil {
				return err
			}
			queued, _ = r.RowsAffected()
			return nil
		}
		for _, t := range o.Targets {
			if !o.All {
				if _, err := tx.NewDelete().Model((*Derivation)(nil)).
					Where("extractor = ? and extractor_version <> ?", t.Name, t.Version).Exec(ctx); err != nil {
					return err
				}
				if _, err := tx.NewRaw(`delete from records r where r.extractor = ?
					and not exists (select 1 from derivations d where d.record_id = r.id)`, t.Name).Exec(ctx); err != nil {
					return err
				}
			}
			r, err := tx.NewRaw(`insert into derivations (raw_hash, extractor, extractor_version)
				select distinct raw_hash, extractor, ? from captures where extractor = ?
				on conflict do nothing`, t.Version, t.Name).Exec(ctx)
			if err != nil {
				return err
			}
			n, _ := r.RowsAffected()
			queued += n
		}
		return nil
	})
	return queued, err
}

func nullable(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
