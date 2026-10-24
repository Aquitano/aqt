package store_test

import (
	"context"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func seedRetirement(t *testing.T) (*store.Store, string, map[string]string) {
	t.Helper()
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	refs := map[string]string{}
	for _, m := range []store.Message{
		msg("youtube", "watch:a", store.Message{Body: "Watched a"}),
		msg("youtube", "watch:b", store.Message{Body: "Watched b"}),
		msg("youtube", "playlist:p", store.Message{Body: "Added to playlist"}),
		msg("youtube", "subscription:s", store.Message{Body: "Subscribed"}),
		msg("json", "watch:a", store.Message{Body: "Another source"}),
	} {
		id, err := st.InsertMessage(ctx, m)
		if err != nil {
			t.Fatal(err)
		}
		row, _, err := st.GetMessage(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		refs[m.Source+"/"+m.ExternalID] = row.Ref
		if m.Source == "youtube" && m.ExternalID == "watch:a" {
			if err := st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "thumb.jpg", SizeBytes: 1, SHA256: strings.Repeat("a", 64)}); err != nil {
				t.Fatal(err)
			}
		}
	}
	return st, dsn, refs
}

func countRows(t *testing.T, dsn string) (messages, attachments, tombstones int64) {
	t.Helper()
	return pgschematest.QueryInt(t, dsn, `select count(*) from messages`),
		pgschematest.QueryInt(t, dsn, `select count(*) from attachments`),
		pgschematest.QueryInt(t, dsn, `select count(*) from message_tombstones`)
}

func TestRetireDryRunReportsWithoutWriting(t *testing.T) {
	ctx := context.Background()
	st, dsn, refs := seedRetirement(t)

	res, err := st.RetireMessages(ctx, store.RetireOptions{Source: "youtube", ExternalPrefixes: []string{"watch:", "playlist:"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied || res.Messages != 3 || len(res.Prefixes) != 2 {
		t.Fatalf("result = %+v", res)
	}
	watch := res.Prefixes[0]
	if watch.Prefix != "watch:" || watch.Messages != 2 || watch.Attachments != 1 || len(watch.Samples) != 2 || watch.Samples[0].Ref != refs["youtube/watch:a"] {
		t.Fatalf("watch prefix = %+v", watch)
	}
	if m, a, ts := countRows(t, dsn); m != 5 || a != 1 || ts != 0 {
		t.Fatalf("dry run wrote: %d messages, %d attachments, %d tombstones", m, a, ts)
	}
}

func TestRetireApplyDeletesMatchingRowsAndRecordsTombstones(t *testing.T) {
	ctx := context.Background()
	st, dsn, refs := seedRetirement(t)
	item := library.Item{Identity: library.Identity{Source: "youtube", Account: "thomas", ExternalID: "video:a"}, Kind: "video", Title: "a"}
	item.ID = library.StableID("item", item.Identity)
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Items: []library.Item{item}}); err != nil {
		t.Fatal(err)
	}
	opts := store.RetireOptions{
		Source: "youtube", ExternalPrefixes: []string{"watch:", "playlist:"}, Reason: "cutover", Apply: true,
		Replacements: map[string]string{refs["youtube/watch:a"]: "item_missing"},
	}
	if _, err := st.RetireMessages(ctx, opts); err == nil {
		t.Fatal("a replacement outside the library was accepted")
	}

	opts.Replacements = map[string]string{refs["youtube/watch:a"]: item.ID, "000000000000": item.ID}
	if _, err := st.RetireMessages(ctx, opts); err == nil || !strings.Contains(err.Error(), "000000000000") {
		t.Fatalf("a map ref matching no retiring message was applied: %v", err)
	}

	delete(opts.Replacements, "000000000000")
	res, err := st.RetireMessages(ctx, opts)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Applied || res.Retired != 3 || res.Replaced != 1 || len(res.UnmatchedReplacements) != 0 {
		t.Fatalf("result = %+v", res)
	}
	if m, a, ts := countRows(t, dsn); m != 2 || a != 0 || ts != 3 {
		t.Fatalf("after apply: %d messages, %d attachments, %d tombstones", m, a, ts)
	}
	for _, key := range []string{"youtube/subscription:s", "json/watch:a"} {
		if _, err := st.GetMessageDetailByRef(ctx, refs[key]); err != nil {
			t.Fatalf("%s should survive: %v", key, err)
		}
	}
	retired, err := st.RetiredByRef(ctx, refs["youtube/watch:a"])
	if err != nil {
		t.Fatal(err)
	}
	if retired.ExternalID != "watch:a" || retired.Reason != "cutover" || retired.Replacement != item.ID || retired.RetiredAt.IsZero() {
		t.Fatalf("tombstone = %+v", retired)
	}
}
