package store_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

func msg(source, externalID string, m store.Message) store.Message {
	m.Source, m.ExternalID = source, externalID
	if m.SentAt.IsZero() {
		m.SentAt = time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC)
	}
	return m
}

func TestMalformedIdentifiersDoNotBreakInsertion(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	// Latin-1 bytes mislabeled as UTF-8 and a stray NUL: both are ordinary in
	// twenty-year-old mail, and both make Postgres reject a text value.
	badID := "abc\xff123@example.com"
	badExternal := "ext\x00id"

	id, err := st.InsertMessage(ctx, msg("proton", badExternal, store.Message{
		MessageID: badID, Sender: "a@example.com", Body: "hello",
	}))
	if err != nil {
		t.Fatalf("insert with malformed ids: %v", err)
	}
	if id == 0 {
		t.Fatal("insert reported a duplicate on an empty archive")
	}

	// Dedup has to normalize the same way, or every re-import inserts again.
	if again, err := st.InsertMessage(ctx, msg("proton", badExternal, store.Message{
		MessageID: badID, Body: "hello",
	})); err != nil || again != 0 {
		t.Fatalf("second insert: id=%d err=%v, want a duplicate", again, err)
	}
	found, err := st.FindMessageID(ctx, "proton", badExternal)
	if err != nil || found != id {
		t.Fatalf("FindMessageID = %d, %v; want %d", found, err, id)
	}
	byMessageID, err := st.FindByEmailMessageID(ctx, "proton", badID)
	if err != nil || byMessageID != id {
		t.Fatalf("FindByEmailMessageID = %d, %v; want %d", byMessageID, err, id)
	}
	has, err := st.HasMessage(ctx, "proton", badExternal)
	if err != nil || !has {
		t.Fatalf("HasMessage = %v, %v", has, err)
	}
}

func TestInsertMessagesBatchesInOrderAndRethreads(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	const n = 1005 // crosses the store's protocol-batch boundary
	at := time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC)
	messages := make([]store.Message, 0, n+1)
	for i := 0; i < n; i++ {
		messages = append(messages, store.Message{
			Source: "batch", ExternalID: fmt.Sprintf("m-%04d", i),
			ThreadID: "old", Subject: "old subject", Body: fmt.Sprintf("body %d", i), SentAt: at,
		})
	}
	// A duplicate inside the same call must preserve result alignment.
	messages = append(messages, messages[0])
	ids, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != len(messages) || ids[0] == 0 || ids[n-1] == 0 || ids[n] != 0 {
		t.Fatalf("ids have wrong shape or duplicate result: first=%d last-new=%d duplicate=%d len=%d",
			ids[0], ids[n-1], ids[n], len(ids))
	}
	if rows := storetest.QueryInt(t, schema, `select count(*) from messages where source = 'batch'`); rows != n {
		t.Fatalf("rows = %d, want %d", rows, n)
	}

	again, err := st.InsertMessages(ctx, messages[:n], store.InsertMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	for i, id := range again {
		if id != 0 {
			t.Fatalf("unchanged row %d returned id %d", i, id)
		}
	}

	newAt := at.Add(time.Hour)
	rethreaded, err := st.InsertMessages(ctx, []store.Message{
		{Source: "batch", ExternalID: "m-0000", ThreadID: "new", Subject: "new subject", Body: "must not replace body", SentAt: newAt},
		{Source: "batch", ExternalID: "fresh", ThreadID: "new", Subject: "fresh", Body: "fresh body", SentAt: newAt},
	}, store.InsertMessagesOpts{Rethread: true})
	if err != nil {
		t.Fatal(err)
	}
	if rethreaded[0] != 0 || rethreaded[1] == 0 {
		t.Fatalf("rethread results = %v, want duplicate then insert", rethreaded)
	}
	got, _, err := st.GetMessage(ctx, ids[0])
	if err != nil {
		t.Fatal(err)
	}
	if got.ThreadID != "new" || got.Subject != "new subject" || !got.SentAt.Equal(newAt) {
		t.Errorf("derived fields were not updated: %+v", got)
	}
	if got.Body != "body 0" {
		t.Errorf("rethread replaced body with %q", got.Body)
	}
}

func TestInsertMessagesCleansWholeBatchBeforeWriting(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	_, err := st.InsertMessages(ctx, []store.Message{
		{Source: "batch", ExternalID: "valid", Body: "would otherwise land", SentAt: time.Now()},
		{Source: "batch", Body: "missing external id", SentAt: time.Now()},
	}, store.InsertMessagesOpts{})
	if err == nil {
		t.Fatal("invalid message did not reject the batch")
	}
	has, err := st.HasMessage(ctx, "batch", "valid")
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Fatal("valid prefix was written before the invalid message was rejected")
	}
}

func TestEmptyResultsAreArrays(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	msgs, err := st.Search(ctx, "nothing here", store.SearchOpts{Limit: 20, Fuzzy: 1})
	if err != nil {
		t.Fatal(err)
	}
	if msgs == nil {
		t.Error("Search returned nil, want an empty slice so JSON is []")
	}
	stats, err := st.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats == nil {
		t.Error("Stats returned nil, want an empty slice so JSON is []")
	}
}

func TestSearchMatchesAndFiltersRecipients(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	if _, err := st.InsertMessage(ctx, msg("gmail", "m1", store.Message{
		Sender:     "alice@example.com",
		Recipients: []string{"Bob Builder <bob@example.com>", "carol@example.com"},
		Subject:    "quarterly numbers",
		Body:       "attached",
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertMessage(ctx, msg("gmail", "m2", store.Message{
		Sender: "dave@example.com", Recipients: []string{"erin@example.com"},
		Subject: "quarterly numbers", Body: "attached",
	})); err != nil {
		t.Fatal(err)
	}

	t.Run("recipients contribute to matching", func(t *testing.T) {
		msgs, err := st.Search(ctx, "builder", store.SearchOpts{Limit: 20, Fuzzy: 0})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 1 || msgs[0].Sender != "alice@example.com" {
			t.Fatalf("got %d results: %+v", len(msgs), msgs)
		}
	})

	t.Run("--to filters case-insensitively", func(t *testing.T) {
		msgs, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0, To: "CAROL"})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) != 1 || msgs[0].Sender != "alice@example.com" {
			t.Fatalf("got %+v", msgs)
		}
		none, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0, To: "nobody"})
		if err != nil {
			t.Fatal(err)
		}
		if len(none) != 0 {
			t.Fatalf("got %+v, want no matches", none)
		}
	})

	t.Run("snippets come back with results", func(t *testing.T) {
		msgs, err := st.Search(ctx, "quarterly", store.SearchOpts{Limit: 20, Fuzzy: 0})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) == 0 {
			t.Fatal("no results")
		}
		for _, m := range msgs {
			if m.Snippet == "" {
				t.Errorf("message %d came back without a snippet", m.ID)
			}
			if strings.Contains(m.Snippet, "&lt;") || strings.Contains(m.Snippet, "<b>") {
				t.Errorf("snippet carries markup: %q", m.Snippet)
			}
		}
	})

	t.Run("fuzzy search still gets a snippet", func(t *testing.T) {
		// pg_search produces no highlight for fuzzy matches, which is exactly
		// when the local fallback has to fill in.
		msgs, err := st.Search(ctx, "quarterlly", store.SearchOpts{Limit: 20, Fuzzy: 2})
		if err != nil {
			t.Fatal(err)
		}
		if len(msgs) == 0 {
			t.Fatal("fuzzy search found nothing")
		}
		if msgs[0].Snippet == "" {
			t.Error("fuzzy result has no snippet")
		}
	})
}

func TestStatsReportFreshness(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	if _, err := st.InsertMessage(ctx, msg("whatsapp", "w1", store.Message{Body: "hi"})); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertMessage(ctx, msg("gmail", "g1", store.Message{Body: "hi"})); err != nil {
		t.Fatal(err)
	}
	if err := st.SetSyncState(ctx, "gmail", []byte(`{"history_id":"42"}`)); err != nil {
		t.Fatal(err)
	}

	stats, err := st.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("stats = %+v", stats)
	}
	by := map[string]store.SourceStats{}
	for _, s := range stats {
		by[s.Source] = s
	}
	for _, s := range stats {
		if s.LastIngest.IsZero() {
			t.Errorf("%s has no last_ingest", s.Source)
		}
	}
	if by["gmail"].LastSync == nil || by["gmail"].LastSync.IsZero() {
		t.Error("a sync-backed source should report last_sync")
	}
	if by["whatsapp"].LastSync != nil {
		t.Error("a manually imported source must not claim a sync time")
	}
}

func TestCoverageNotesAndStaleness(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	if _, err := st.InsertMessage(ctx, msg("whatsapp", "w1", store.Message{Body: "hi"})); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertMessage(ctx, msg("gmail", "g1", store.Message{Body: "hi"})); err != nil {
		t.Fatal(err)
	}
	// ingested_at defaults to now, so staleness needs a row that was written
	// long enough ago to count.
	storetest.Exec(t, schema,
		`update messages set ingested_at = now() - interval '90 days' where source = 'whatsapp'`)

	if err := st.SetCoverage(ctx, "whatsapp", "only the chats exported in 2025-08; nothing before"); err != nil {
		t.Fatal(err)
	}
	by := func() map[string]store.SourceStats {
		t.Helper()
		stats, err := st.Stats(ctx)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]store.SourceStats{}
		for _, s := range stats {
			out[s.Source] = s
		}
		return out
	}

	stats := by()
	if !strings.HasPrefix(stats["whatsapp"].Coverage, "only the chats") {
		t.Errorf("coverage = %q", stats["whatsapp"].Coverage)
	}
	if !stats["whatsapp"].Stale {
		t.Error("a source with nothing new in 90 days should be flagged stale")
	}
	if stats["gmail"].Stale || stats["gmail"].Coverage != "" {
		t.Errorf("gmail = %+v, want fresh and unannotated", stats["gmail"])
	}
	// A coverage note is written by hand and must not read as a sync.
	if stats["whatsapp"].LastSync != nil {
		t.Error("a coverage note claimed to be a sync checkpoint")
	}

	if err := st.SetCoverage(ctx, "whatsapp", ""); err != nil {
		t.Fatal(err)
	}
	if c := by()["whatsapp"].Coverage; c != "" {
		t.Errorf("coverage = %q after clearing", c)
	}
}

func TestThreads(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seed := func(source, thread string, n int) {
		for i := range n {
			_, err := st.InsertMessage(ctx, msg(source, fmt.Sprintf("%s-%s-%d", source, thread, i), store.Message{
				ThreadID: thread,
				Sender:   fmt.Sprintf("sender%d", i),
				Body:     fmt.Sprintf("message %d", i),
				SentAt:   time.Date(2024, 5, 13, 21, 0, i, 0, time.UTC),
			}))
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	seed("whatsapp", "Alice", 5)
	seed("discord", "shared", 2)
	seed("whatsapp", "shared", 3)

	t.Run("chronological and complete", func(t *testing.T) {
		th, err := st.GetThread(ctx, "", "Alice", 0)
		if err != nil {
			t.Fatal(err)
		}
		if th.Source != "whatsapp" || len(th.Messages) != 5 || th.Truncated {
			t.Fatalf("thread = %+v", th)
		}
		for i, m := range th.Messages {
			if m.Body != fmt.Sprintf("message %d", i) {
				t.Fatalf("message %d out of order: %q", i, m.Body)
			}
		}
	})

	t.Run("empty", func(t *testing.T) {
		if _, err := st.GetThread(ctx, "", "no-such-thread", 0); err != store.ErrNotFound {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("ambiguous", func(t *testing.T) {
		_, err := st.GetThread(ctx, "", "shared", 0)
		var amb *store.AmbiguousThreadError
		if !asAmbiguous(err, &amb) {
			t.Fatalf("err = %v, want AmbiguousThreadError", err)
		}
		if len(amb.Sources) != 2 {
			t.Fatalf("sources = %v", amb.Sources)
		}
		th, err := st.GetThread(ctx, "whatsapp", "shared", 0)
		if err != nil || len(th.Messages) != 3 {
			t.Fatalf("disambiguated thread = %+v, err = %v", th, err)
		}
	})

	t.Run("large thread truncates and says so", func(t *testing.T) {
		th, err := st.GetThread(ctx, "whatsapp", "Alice", 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(th.Messages) != 2 || !th.Truncated {
			t.Fatalf("thread = %+v", th)
		}
	})
}

func asAmbiguous(err error, target **store.AmbiguousThreadError) bool {
	amb, ok := err.(*store.AmbiguousThreadError)
	if ok {
		*target = amb
	}
	return ok
}

// The body healer is the only write allowed past "a re-import never overwrites
// a body", so the rule that keeps it safe — strictly more text wins, nothing
// else moves — is what this pins down.
func TestSetLongerMessageBodyOnlyGrows(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	const stub = "Diese Nachricht ist im HTML-Format."
	const full = "Ihr Dauerauftrag ueber 450,00 EUR an Hausverwaltung Meier wurde eingerichtet."

	id, err := st.InsertMessage(ctx, msg("gmail", "stub@example.com", store.Message{
		MessageID: "stub@example.com", Sender: "bank@example.com", Subject: "Dauerauftrag", Body: stub,
	}))
	if err != nil || id == 0 {
		t.Fatalf("seed: %d %v", id, err)
	}

	for _, tc := range []struct {
		name string
		body string
		want bool
	}{
		{"longer wins", full, true},
		{"equal is left alone", full, false},
		{"shorter never shrinks the row", stub, false},
		{"whitespace is not text", full + "\n\n\t  ", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			healed, err := st.SetLongerMessageBody(ctx, id, tc.body)
			if err != nil {
				t.Fatal(err)
			}
			if healed != tc.want {
				t.Errorf("healed = %v, want %v", healed, tc.want)
			}
			body, err := st.MessageBody(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if body != full {
				t.Errorf("body = %q, want %q", body, full)
			}
		})
	}
}
