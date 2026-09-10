package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/aquitano/aqt/apps/tracker/internal/store"
	"github.com/aquitano/aqt/apps/tracker/internal/storetest"
	"github.com/aquitano/aqt/apps/tracker/internal/urlnorm"
)

func urlKey(t *testing.T, raw string) store.URLKey {
	t.Helper()
	normalized, host, err := urlnorm.Normalize(raw)
	if err != nil {
		t.Fatal(err)
	}
	return store.URLKey{Hash: urlnorm.Hash(normalized), Normalized: normalized, Host: host}
}

func apply(t *testing.T, st *store.Store, device uuid.UUID, ev store.Events) store.EventResult {
	t.Helper()
	res, err := st.ApplyEvents(context.Background(), device, ev)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestDesktopSpanRoundTrips(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device, id := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)

	apply(t, st, device, store.Events{SpanStarts: []store.SpanStartEvent{
		{ID: id, AppName: "Code", BundleID: "com.microsoft.VSCode", WindowTitle: "main.go — aqt", StartedAt: start}}})
	apply(t, st, device, store.Events{Heartbeats: []store.SpanHeartbeatEvent{{ID: id, At: start.Add(30 * time.Second)}}})
	apply(t, st, device, store.Events{SpanEnds: []store.SpanEndEvent{
		{ID: id, EndedAt: start.Add(time.Minute), Reason: "app_switch"}}})

	stored := storetest.QueryInt(t, schema, `select count(*) from activity_spans
		where id = $1 and page_view_id is null and app_name = 'Code' and bundle_id = 'com.microsoft.VSCode'
		  and window_title = 'main.go — aqt' and end_reason = 'app_switch'
		  and ended_at = started_at + interval '60 seconds'`, id)
	if stored != 1 {
		t.Fatalf("desktop span rows matching the round trip: %d, want 1", stored)
	}
}

func TestWorkBlocksSplitOnGapsOverMaxGap(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device := uuid.Must(uuid.NewV7())
	base := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	span := func(offset time.Duration, reason string) {
		t.Helper()
		id := uuid.Must(uuid.NewV7())
		apply(t, st, device, store.Events{
			SpanStarts: []store.SpanStartEvent{{ID: id, AppName: "Code", StartedAt: base.Add(offset)}},
			SpanEnds:   []store.SpanEndEvent{{ID: id, EndedAt: base.Add(offset + time.Minute), Reason: reason}}})
	}
	span(0, "app_switch")
	span(80*time.Second, "app_switch")
	span(260*time.Second, "idle")

	from, to := base.Add(-time.Hour), base.Add(time.Hour)
	if blocks := storetest.QueryInt(t, schema, `select count(*) from work_blocks($1, $2)`, from, to); blocks != 2 {
		t.Fatalf("work_blocks returned %d blocks, want 2", blocks)
	}
	shape := storetest.QueryInt(t, schema, `select count(*) from work_blocks($1, $2)
		where (span_count, switches, dominant_category) in ((2, 2, 'Focus/Code'), (1, 0, 'Focus/Code'))`, from, to)
	if shape != 2 {
		t.Fatalf("blocks with the expected span_count and switches: %d, want 2", shape)
	}
}

func TestCategorizedSpansMatchAppsAndHosts(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device := uuid.Must(uuid.NewV7())
	pv, browser, desktop := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)

	apply(t, st, device, store.Events{
		PageViews: []store.PageViewEvent{{ID: pv, URL: urlKey(t, "https://www.youtube.com/watch?v=abc"),
			Title: "a video", StartedAt: start, NavigationType: "load"}},
		SpanStarts: []store.SpanStartEvent{
			{ID: browser, PageViewID: pv, StartedAt: start},
			{ID: desktop, AppName: "Code", StartedAt: start}}})

	matched := storetest.QueryInt(t, schema, `select count(*) from categorized_spans
		where (id, source, category) in (($1, 'page', 'Distraction'), ($2, 'desktop', 'Focus/Code'))
		  and (host = 'www.youtube.com' or app_name = 'Code')`, browser, desktop)
	if matched != 2 {
		t.Fatalf("categorized spans matching their rules: %d, want 2", matched)
	}
}
