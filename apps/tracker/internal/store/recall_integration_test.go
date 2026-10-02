package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/blob"
	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
)

func insertCapture(t *testing.T, st *store.Store, device, pv uuid.UUID, page store.URLKey, html string, at time.Time) []byte {
	t.Helper()
	hash := blob.Hash([]byte(html))
	payload := blob.Compress([]byte(html))
	if _, err := st.InsertCapture(context.Background(), store.CaptureInput{
		Capture: store.Capture{ID: uuid.Must(uuid.NewV7()), PageViewID: pv, DeviceID: device, RawHash: hash[:],
			Extractor: "fake", CapturedAt: at, Reason: "initial", URL: page.Normalized},
		URL:     page,
		Blob:    store.RawHTMLBlob{Hash: hash[:], Codec: blob.CodecZstd, RawBytes: len(html), StoredBytes: len(payload), Payload: payload},
		Version: 1,
	}); err != nil {
		t.Fatal(err)
	}
	return hash[:]
}

func completeRecord(t *testing.T, st *store.Store, hash []byte, page store.URLKey, searchText string, at time.Time) int64 {
	t.Helper()
	res, err := st.CompleteDerivation(context.Background(), store.DerivationKey{RawHash: hash, Extractor: "fake", Version: 1},
		store.RecordInput{URL: page, Record: store.Record{Extractor: "fake", RecordHash: hash, CanonicalURL: page.Normalized,
			Title: "Bun", SearchText: searchText, Data: []byte(`{}`), FirstSeenAt: at, LastSeenAt: at}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	return res.ID
}

func browserSpan(pv uuid.UUID, start time.Time, length time.Duration) store.Events {
	id := uuid.Must(uuid.NewV7())
	return store.Events{
		SpanStarts: []store.SpanStartEvent{{ID: id, PageViewID: pv, StartedAt: start}},
		SpanEnds:   []store.SpanEndEvent{{ID: id, EndedAt: start.Add(length), Reason: "tab_switch"}},
	}
}

func TestRecordVisitsCountEachPageViewOnce(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	device := uuid.Must(uuid.NewV7())
	page, other := urlKey(t, "https://example.com/a"), urlKey(t, "https://example.com/b")
	start := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	captured, revisit, elsewhere := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	apply(t, st, device, store.Events{PageViews: []store.PageViewEvent{
		{ID: captured, URL: page, StartedAt: start, NavigationType: "load"},
		{ID: revisit, URL: page, StartedAt: start.Add(24 * time.Hour), NavigationType: "load"},
		{ID: elsewhere, URL: other, StartedAt: start.Add(time.Hour), NavigationType: "load"},
	}})
	apply(t, st, device, browserSpan(captured, start, time.Minute))
	apply(t, st, device, browserSpan(captured, start.Add(5*time.Minute), 30*time.Second))
	apply(t, st, device, browserSpan(revisit, start.Add(24*time.Hour), 45*time.Second))
	apply(t, st, device, browserSpan(elsewhere, start.Add(time.Hour), 10*time.Minute))

	hash := insertCapture(t, st, device, captured, page, "<p>bun orm for postgres</p>", start)
	insertCapture(t, st, device, captured, page, "<p>bun orm for postgres</p>", start.Add(5*time.Minute))
	id := completeRecord(t, st, hash, page, "bun orm for postgres", start)

	hits, err := st.Search(ctx, store.SearchOpts{Query: "postgres", Limit: 10})
	if err != nil || len(hits) != 1 {
		t.Fatalf("hits = %+v (%v)", hits, err)
	}
	v := hits[0].Visits
	if v.Count != 2 || v.ActiveSeconds != 135 || v.FirstAt == nil || !v.FirstAt.Equal(start) ||
		v.LastAt == nil || !v.LastAt.Equal(start.Add(24*time.Hour)) {
		t.Errorf("visits = %+v, want 2 page views from %s to %s with 135 s", v, start, start.Add(24*time.Hour))
	}

	rec, err := st.Record(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if rec.SearchText != "bun orm for postgres" || rec.Visits.Count != v.Count || rec.Visits.ActiveSeconds != v.ActiveSeconds {
		t.Errorf("record = %+v, want the search text and the hit's visits", rec)
	}
}

func TestURLVisitsCountOnlyPageViewsBeforeTheGivenTime(t *testing.T) {
	st := storetest.New(t)
	device := uuid.Must(uuid.NewV7())
	start := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	for i, raw := range []string{"https://example.com/a?utm_source=x", "https://example.com/a", "https://example.com/a"} {
		apply(t, st, device, store.Events{PageViews: []store.PageViewEvent{{ID: uuid.Must(uuid.NewV7()),
			URL: urlKey(t, raw), StartedAt: start.Add(time.Duration(i) * time.Hour), NavigationType: "load"}}})
	}

	v, err := st.URLVisits(context.Background(), urlKey(t, "https://example.com/a").Hash, start.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if v.Count != 2 || v.LastAt == nil || !v.LastAt.Equal(start.Add(time.Hour)) {
		t.Errorf("visits before the third = %+v, want 2, the last at %s", v, start.Add(time.Hour))
	}
	none, err := st.URLVisits(context.Background(), urlKey(t, "https://example.com/never").Hash, time.Time{})
	if err != nil || none.Count != 0 || none.FirstAt != nil {
		t.Errorf("unvisited page = %+v (%v), want zero visits", none, err)
	}
}
