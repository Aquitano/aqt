// Package processor runs the extraction workers. The derivation row is the
// job: claim it, run the extractor outside any transaction, write the result
// in one short transaction.
package processor

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
	"github.com/aquitano/aqt/apps/tracker/internal/metrics"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

const (
	ExtractTimeout = 30 * time.Second
	IdleSleep      = 2 * time.Second
)

const (
	ClassPanic        = "panic"
	ClassParse        = "parse"
	ClassNoMatch      = "no_match"
	ClassStale        = "stale"
	ClassStore        = "store"
	ClassTimeout      = "timeout"
	ClassTooLarge     = "too_large"
	ClassUnregistered = "unregistered"
	ResultDone        = "done"
)

type Processor struct {
	store   *store.Store
	metrics *metrics.Metrics
	log     *slog.Logger
	workers int
	wake    chan struct{}
}

func New(st *store.Store, m *metrics.Metrics, log *slog.Logger, workers int) *Processor {
	return &Processor{store: st, metrics: m, log: log, workers: workers, wake: make(chan struct{}, 1)}
}

// Wake nudges one idle worker; a full channel means one is already on its way.
func (p *Processor) Wake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Processor) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for i := range p.workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.loop(ctx, i)
		}()
	}
	wg.Wait()
}

func (p *Processor) loop(ctx context.Context, worker int) {
	for ctx.Err() == nil {
		busy, err := p.RunOnce(ctx)
		if err != nil && ctx.Err() == nil {
			p.log.Error("worker", "worker", worker, "err", err)
		}
		if busy {
			continue
		}
		select {
		case <-ctx.Done():
		case <-p.wake:
		case <-time.After(IdleSleep):
		}
	}
}

// RunOnce claims and finishes one derivation. busy is false when the queue
// was empty.
func (p *Processor) RunOnce(ctx context.Context) (busy bool, err error) {
	d, ok, err := p.store.ClaimDerivation(ctx)
	if err != nil || !ok {
		return false, err
	}
	start := time.Now()
	rec, fail := p.derive(ctx, d)
	elapsed := time.Since(start)
	p.metrics.ExtractDuration.WithLabelValues(d.Extractor).Observe(elapsed.Seconds())
	writeCtx := context.WithoutCancel(ctx)
	log := p.log.With("extractor", d.Extractor, "version", d.ExtractorVersion,
		"raw_hash", hex.EncodeToString(d.RawHash), "attempts", d.Attempts, "ms", elapsed.Milliseconds())
	if fail != nil {
		retry := !fail.permanent && d.Attempts < store.MaxAttempts
		p.metrics.Derivations.WithLabelValues(d.Extractor, fail.class).Inc()
		log.Warn("derivation failed", "class", fail.class, "retry", retry, "err", fail.err)
		return true, p.store.FailDerivation(writeCtx, d.Key(), store.Failure{Error: fail.err.Error(), Class: fail.class, Retry: retry})
	}
	res, err := p.store.CompleteDerivation(writeCtx, d.Key(), rec, elapsed)
	if err != nil {
		retry := d.Attempts < store.MaxAttempts
		p.metrics.Derivations.WithLabelValues(d.Extractor, ClassStore).Inc()
		log.Warn("derivation failed", "class", ClassStore, "retry", retry, "err", err)
		return true, errors.Join(err, p.store.FailDerivation(writeCtx, d.Key(), store.Failure{Error: err.Error(), Class: ClassStore, Retry: retry}))
	}
	p.metrics.Derivations.WithLabelValues(d.Extractor, ResultDone).Inc()
	p.metrics.Records.WithLabelValues(d.Extractor, fmt.Sprint(res.Deduplicated)).Inc()
	log.Info("derivation done", "record_id", res.ID, "dedup", res.Deduplicated)
	return true, nil
}

type failure struct {
	err       error
	class     string
	permanent bool
}

func (p *Processor) derive(ctx context.Context, d store.Derivation) (store.RecordInput, *failure) {
	e, ok := extractor.Lookup(d.Extractor)
	if !ok || e.Rule().Version != d.ExtractorVersion {
		return store.RecordInput{}, &failure{
			err:   fmt.Errorf("%s v%d is not registered in this binary", d.Extractor, d.ExtractorVersion),
			class: ClassUnregistered, permanent: true}
	}
	b, err := p.store.LoadBlob(ctx, d.RawHash)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse}
	}
	html, err := blob.Decompress(b.Payload)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse}
	}
	if max := e.Rule().WithDefaults().MaxBytes; len(html) > max {
		return store.RecordInput{}, &failure{err: fmt.Errorf("%d bytes exceeds max_bytes %d", len(html), max), class: ClassTooLarge, permanent: true}
	}
	summary, err := p.store.SummarizeCaptures(ctx, d.RawHash)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse}
	}
	normalized, host, err := urlnorm.Normalize(summary.URL)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse, permanent: true}
	}
	pageURL, err := url.Parse(normalized)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse, permanent: true}
	}
	rec, err := extract(ctx, e, html, pageURL)
	if err != nil {
		return store.RecordInput{}, classify(err)
	}
	canonical, err := extractor.CanonicalJSON(rec.Data)
	if err != nil {
		return store.RecordInput{}, &failure{err: err, class: ClassParse}
	}
	hash := blake3.Sum256(canonical)
	return store.RecordInput{
		Record: store.Record{Extractor: d.Extractor, RecordHash: hash[:], CanonicalURL: rec.CanonicalURL,
			Title: rec.Title, SearchText: rec.SearchText, Data: canonical,
			FirstSeenAt: summary.FirstSeen, LastSeenAt: summary.LastSeen},
		URL: store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host},
	}, nil
}

type panicError struct{ value any }

func (e panicError) Error() string { return fmt.Sprintf("panic: %v", e.value) }

func extract(ctx context.Context, e extractor.Extractor, html []byte, pageURL *url.URL) (extractor.Record, error) {
	ctx, cancel := context.WithTimeout(ctx, ExtractTimeout)
	defer cancel()
	type result struct {
		rec extractor.Record
		err error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- result{err: panicError{r}}
			}
		}()
		rec, err := e.Extract(ctx, html, pageURL)
		done <- result{rec, err}
	}()
	select {
	case r := <-done:
		return r.rec, r.err
	case <-ctx.Done():
		return extractor.Record{}, ctx.Err()
	}
}

func classify(err error) *failure {
	var p panicError
	switch {
	case errors.Is(err, extractor.ErrNoMatch):
		return &failure{err: err, class: ClassNoMatch, permanent: true}
	case errors.Is(err, extractor.ErrStale):
		return &failure{err: err, class: ClassStale, permanent: true}
	// Extractors cannot be interrupted, so a timed-out run keeps its goroutine
	// until it finishes. A retry would start another copy of work that already
	// took too long.
	case errors.Is(err, context.DeadlineExceeded):
		return &failure{err: err, class: ClassTimeout, permanent: true}
	case errors.Is(err, context.Canceled):
		return &failure{err: err, class: ClassTimeout}
	case errors.As(err, &p):
		return &failure{err: err, class: ClassPanic}
	}
	return &failure{err: err, class: ClassParse}
}
