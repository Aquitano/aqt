package store_test

import (
	"context"
	"slices"
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

func TestIdleEndRollsBackPastHeartbeatsButNotBeforeTheStart(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device := uuid.Must(uuid.NewV7())
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	span := func(idleAt time.Time) uuid.UUID {
		t.Helper()
		id := uuid.Must(uuid.NewV7())
		apply(t, st, device, store.Events{SpanStarts: []store.SpanStartEvent{{ID: id, AppName: "Code", StartedAt: start}}})
		apply(t, st, device, store.Events{Heartbeats: []store.SpanHeartbeatEvent{{ID: id, At: start.Add(60 * time.Second)}}})
		apply(t, st, device, store.Events{SpanEnds: []store.SpanEndEvent{{ID: id, EndedAt: idleAt, Reason: "idle"}}})
		return id
	}
	rolledBack := span(start.Add(5 * time.Second))
	clamped := span(start.Add(-10 * time.Second))

	matched := storetest.QueryInt(t, schema, `select count(*) from activity_spans
		where (id, ended_at) in (($1, $3::timestamptz + interval '5 seconds'), ($2, $3::timestamptz)) and end_reason = 'idle'`,
		rolledBack, clamped, start)
	if matched != 2 {
		t.Fatalf("idle spans ending at the last input: %d, want 2", matched)
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

func TestIdleBatchReplayPreservesEndedAt(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device, id := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	start := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	events := store.Events{
		SpanStarts: []store.SpanStartEvent{{ID: id, AppName: "Code", StartedAt: start}},
		Heartbeats: []store.SpanHeartbeatEvent{{ID: id, At: start.Add(45 * time.Second)}},
		SpanEnds:   []store.SpanEndEvent{{ID: id, EndedAt: start.Add(5 * time.Second), Reason: "idle"}},
	}
	apply(t, st, device, events)
	apply(t, st, device, events)
	apply(t, st, device, store.Events{Heartbeats: []store.SpanHeartbeatEvent{{ID: id, At: start.Add(time.Minute)}}})
	seconds := storetest.QueryInt(t, schema, `select extract(epoch from ended_at - started_at)::bigint
		from activity_spans where id = $1`, id)
	if seconds != 5 {
		t.Fatalf("active seconds after replay and late heartbeat: %d, want 5", seconds)
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

func TestCategoryCoverageSeeds(t *testing.T) {
	st, schema := storetest.NewNamed(t)
	device := uuid.Must(uuid.NewV7())
	start := time.Now().UTC()
	cases := []struct{ app, host, category string }{
		{app: "\u200eWhatsApp", category: "Communication"},
		{app: "ChatGPT", category: "AI"},
		{app: "Brave Browser Nightly", category: "Browsing"},
		{app: "Docker Desktop", category: "Focus/Code"},
		{app: "Finder", category: "System"},
		{app: "Affinity", category: "Design"},
		{host: "www.perplexity.ai", category: "AI"},
		{host: "www.google.com", category: "Browsing"},
		{host: "www.amazon.de", category: "Personal"},
		{host: "www.overleaf.com", category: "Learning"},
		{host: "www.disneyplus.com", category: "Distraction"},
		{host: "dash.cloudflare.com", category: "Focus/Code"},
		{host: "developer.apple.com", category: "Learning"},
		{host: "docs.python.org", category: "Learning"},
		{host: "docs.google.com", category: "Productivity"},
	}
	for _, tc := range cases {
		t.Run(tc.app+tc.host, func(t *testing.T) {
			id := uuid.Must(uuid.NewV7())
			event := store.SpanStartEvent{ID: id, AppName: tc.app, StartedAt: start}
			events := store.Events{}
			if tc.host != "" {
				event.PageViewID = uuid.Must(uuid.NewV7())
				events.PageViews = []store.PageViewEvent{{ID: event.PageViewID, URL: urlKey(t, "https://"+tc.host), StartedAt: start, NavigationType: "load"}}
			}
			events.SpanStarts = []store.SpanStartEvent{event}
			apply(t, st, device, events)
			if got := storetest.QueryInt(t, schema, `select count(*) from categorized_spans where id = $1 and category = $2`, id, tc.category); got != 1 {
				t.Fatalf("expected category %q", tc.category)
			}
		})
	}
}

func TestTimeClipsSpansToTheWindow(t *testing.T) {
	st := storetest.New(t)
	device := uuid.Must(uuid.NewV7())
	from := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	github, elsewhere := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	apply(t, st, device, store.Events{PageViews: []store.PageViewEvent{
		{ID: github, URL: urlKey(t, "https://github.com/aquitano/aqt"), StartedAt: from.Add(-10 * time.Minute), NavigationType: "load"},
		{ID: elsewhere, URL: urlKey(t, "https://example.org/"), StartedAt: from.Add(45 * time.Minute), NavigationType: "load"},
	}})
	desktop := func(start time.Time, length time.Duration) store.Events {
		id := uuid.Must(uuid.NewV7())
		return store.Events{
			SpanStarts: []store.SpanStartEvent{{ID: id, AppName: "Code", StartedAt: start}},
			SpanEnds:   []store.SpanEndEvent{{ID: id, EndedAt: start.Add(length), Reason: "app_switch"}},
		}
	}
	apply(t, st, device, browserSpan(github, from.Add(-10*time.Minute), 30*time.Minute))
	apply(t, st, device, browserSpan(elsewhere, from.Add(45*time.Minute), 5*time.Minute))
	apply(t, st, device, desktop(from.Add(30*time.Minute), 10*time.Minute))
	apply(t, st, device, desktop(from.Add(-2*time.Hour), 10*time.Minute))

	for by, want := range map[string][]store.TimeRow{
		"host":     {{Key: "github.com", ActiveSeconds: 1200}, {Key: "example.org", ActiveSeconds: 300}},
		"app":      {{Key: "Code", ActiveSeconds: 600}},
		"category": {{Key: "Focus/Code", ActiveSeconds: 1800}, {Key: "uncategorized", ActiveSeconds: 300}},
	} {
		rows, err := st.Time(context.Background(), store.TimeOpts{From: from, To: from.Add(time.Hour), By: by})
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(rows, want) {
			t.Errorf("by %s: %+v, want %+v", by, rows, want)
		}
	}
}
