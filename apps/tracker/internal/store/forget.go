package store

import (
	"cmp"
	"context"
	"database/sql"

	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

// ForgetTarget names a page by its normalised URL, or a host together with
// its subdomains.
type ForgetTarget struct {
	URL  string `json:"url,omitempty"`
	Host string `json:"host,omitempty"`
}

type Forgotten struct {
	PageViews int64 `json:"page_views"`
	Spans     int64 `json:"spans"`
	Captures  int64 `json:"captures"`
	Blobs     int64 `json:"blobs"`
	Records   int64 `json:"records"`
}

// conditions select the target's urls rows and its records by canonical URL,
// both over the single argument ?0.
func (t ForgetTarget) conditions() (urls, records string) {
	if t.Host != "" {
		return onHost("host"), onHost(`substring(canonical_url from '^[a-z]+://([^/:]+)')`)
	}
	return "normalized_url = ?0", "canonical_url = ?0"
}

func onHost(expr string) string {
	return "(" + expr + " = ?0 or right(" + expr + ", length(?0) + 1) = '.' || ?0)"
}

// Forget deletes everything recorded for a page or a host in one
// transaction: its page views with their spans and captures, the blobs and
// derivations no capture is left for, other page views' referrer links to
// it, and its urls rows. A record goes when its canonical or page URL is the
// target or one of its blobs went; the derivations of its remaining blobs go
// back to pending, so the worker rebuilds it from what is left.
func (s *Store) Forget(ctx context.Context, t ForgetTarget) (Forgotten, error) {
	urls, canonical := t.conditions()
	arg := cmp.Or(t.Host, t.URL)
	target := `select id from urls where ` + urls
	pageViews := `select id from page_views where url_id in (` + target + `)`
	var f Forgotten
	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var err error
		if f.Spans, err = rowsAffected(tx.NewRaw(`delete from activity_spans where page_view_id in (`+pageViews+`)`, arg).Exec(ctx)); err != nil {
			return err
		}
		var hashes [][]byte
		if err := tx.NewRaw(`delete from captures where page_view_id in (`+pageViews+`) returning raw_hash`, arg).Scan(ctx, &hashes); err != nil {
			return err
		}
		f.Captures = int64(len(hashes))
		if f.PageViews, err = rowsAffected(tx.NewRaw(`delete from page_views where url_id in (`+target+`)`, arg).Exec(ctx)); err != nil {
			return err
		}
		if _, err := tx.NewRaw(`update page_views set referrer_url_id = null where referrer_url_id in (`+target+`)`, arg).Exec(ctx); err != nil {
			return err
		}
		var orphanRecords []int64
		if err := tx.NewRaw(`with gone as (
				delete from derivations d where d.raw_hash = any(?0)
				and not exists (select 1 from captures c where c.raw_hash = d.raw_hash)
				returning record_id)
			select distinct record_id from gone where record_id is not null`, pgdialect.Array(hashes)).Scan(ctx, &orphanRecords); err != nil {
			return err
		}
		if f.Blobs, err = rowsAffected(tx.NewRaw(`delete from raw_html_blobs b where b.hash = any(?0)
			and not exists (select 1 from captures c where c.raw_hash = b.hash)`, pgdialect.Array(hashes)).Exec(ctx)); err != nil {
			return err
		}
		doomed := `select id from records where id = any(?1) or url_id in (` + target + `) or ` + canonical
		if _, err := tx.NewRaw(`update derivations set status = ?2, record_id = null, attempts = 0, claimed_at = null,
				last_error = null, error_class = null, updated_at = now()
			where record_id in (`+doomed+`)`, arg, pgdialect.Array(orphanRecords), StatusPending).Exec(ctx); err != nil {
			return err
		}
		if f.Records, err = rowsAffected(tx.NewRaw(`delete from records where id in (`+doomed+`)`, arg, pgdialect.Array(orphanRecords)).Exec(ctx)); err != nil {
			return err
		}
		_, err = tx.NewRaw(`delete from urls where `+urls, arg).Exec(ctx)
		return err
	})
	if err != nil {
		return Forgotten{}, err
	}
	return f, nil
}

func rowsAffected(r sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}
