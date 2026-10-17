package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestForgetHostDeletesEverythingRecordedForIt(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	device := uuid.Must(uuid.NewV7())
	at := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	page, sub, kept := urlKey(t, "https://example.com/a"), urlKey(t, "https://blog.example.com/post"), urlKey(t, "https://notexample.com/b")
	pagePV, subPV, keptPV := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	apply(t, st, device, store.Events{PageViews: []store.PageViewEvent{
		{ID: pagePV, URL: page, Title: "A", StartedAt: at, NavigationType: "load"},
		{ID: subPV, URL: sub, Title: "Post", StartedAt: at.Add(time.Minute), NavigationType: "load"},
		{ID: keptPV, URL: kept, Referrer: &page, Title: "B", StartedAt: at.Add(2 * time.Minute), NavigationType: "load"},
	}})
	for _, pv := range []uuid.UUID{pagePV, subPV, keptPV} {
		apply(t, st, device, browserSpan(pv, at.Add(3*time.Minute), time.Minute))
	}
	only := insertCapture(t, st, device, pagePV, page, "<p>only on example.com</p>", at)
	shared := insertCapture(t, st, device, subPV, sub, "<p>the same on both hosts</p>", at.Add(time.Minute))
	insertCapture(t, st, device, keptPV, kept, "<p>the same on both hosts</p>", at.Add(2*time.Minute))
	keptOnly := insertCapture(t, st, device, keptPV, kept, "<p>only on notexample.com</p>", at.Add(2*time.Minute))
	completeRecord(t, st, only, page, "only on example.com", at)
	// Keyed on blog.example.com, this record goes, and the shared blob's
	// derivation is queued again to rebuild it from notexample.com's capture.
	completeRecord(t, st, shared, sub, "the same on both hosts", at)
	completeRecord(t, st, keptOnly, kept, "only on notexample.com", at)

	got, err := st.Forget(context.Background(), store.ForgetTarget{Host: "example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if want := (store.Forgotten{PageViews: 2, Spans: 2, Captures: 2, Blobs: 1, Records: 2}); got != want {
		t.Errorf("forgot %+v, want %+v", got, want)
	}
	for query, want := range map[string]int64{
		`select count(*) from urls`:                                                       1,
		`select count(*) from urls where host = 'notexample.com'`:                         1,
		`select count(*) from page_views`:                                                 1,
		`select count(*) from page_views where referrer_url_id is not null`:               0,
		`select count(*) from activity_spans`:                                             1,
		`select count(*) from captures`:                                                   2,
		`select count(*) from raw_html_blobs`:                                             2,
		`select count(*) from records where canonical_url = 'https://notexample.com/b'`:   1,
		`select count(*) from records`:                                                    1,
		`select count(*) from derivations`:                                                2,
		`select count(*) from derivations where status = 'pending' and record_id is null`: 1,
	} {
		if n := pgschematest.QueryInt(t, dsn, query); n != want {
			t.Errorf("%s: %d, want %d", query, n, want)
		}
	}
}

func TestADerivationForgottenWhileItRanWritesNoRecord(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	device, pv := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	page := urlKey(t, "https://example.com/a")
	at := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	apply(t, st, device, store.Events{PageViews: []store.PageViewEvent{{ID: pv, URL: page, StartedAt: at, NavigationType: "load"}}})
	hash := insertCapture(t, st, device, pv, page, "<p>forgotten mid-extraction</p>", at)

	if _, err := st.Forget(context.Background(), store.ForgetTarget{URL: page.Normalized}); err != nil {
		t.Fatal(err)
	}
	_, err := st.CompleteDerivation(context.Background(), store.DerivationKey{RawHash: hash, Extractor: "fake", Version: 1},
		store.RecordInput{URL: page, Record: store.Record{Extractor: "fake", RecordHash: hash, CanonicalURL: page.Normalized,
			SearchText: "forgotten mid-extraction", Data: []byte(`{}`), FirstSeenAt: at, LastSeenAt: at}}, 0)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select (select count(*) from records) + (select count(*) from urls)`); n != 0 {
		t.Errorf("%d records and urls rows written for a forgotten page", n)
	}
}
