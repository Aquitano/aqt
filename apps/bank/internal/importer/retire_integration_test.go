package importer

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/generic"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/verify"
	"github.com/aquitano/aqt/apps/bank/internal/youtube"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// Every path that replays archived input — JSON re-upload, reimport, heal —
// must leave a retired key retired.
func TestRetiredMessagesStayRetired(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	dir := t.TempDir()
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	target := Target{Store: st, Blobs: blobs, ArchiveDir: filepath.Join(dir, "archive")}
	write := func(name, content string) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	upload := write("upload.json", `[{"external_id":"watch:1","body":"Watched Rust"},{"external_id":"subscription:1","body":"Subscribed"}]`)
	history := write("watch-history.json", `[{"header":"YouTube","title":"Watched Rust in 100 Seconds",`+
		`"titleUrl":"https://www.youtube.com/watch?v=5C_HPTJg5ek","time":"2026-08-14T09:12:33.123Z"}]`)

	if _, err := Run(ctx, target, "json", Input{Path: upload, Source: "youtube"}); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(ctx, target, "youtube", Input{Path: history}); err != nil {
		t.Fatal(err)
	}
	hits, err := st.Search(ctx, "seconds", store.SearchOpts{Source: "youtube", Limit: 10})
	if err != nil || len(hits) != 1 {
		t.Fatalf("native youtube row: %+v %v", hits, err)
	}
	native, _, err := st.GetMessage(ctx, hits[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RetireMessages(ctx, store.RetireOptions{
		Source: "youtube", ExternalPrefixes: []string{"watch:", native.ExternalID}, Apply: true,
	}); err != nil {
		t.Fatal(err)
	}

	res, err := Run(ctx, target, "json", Input{Path: upload, Source: "youtube"})
	if err != nil || res.(generic.Result).Inserted != 0 {
		t.Fatalf("JSON re-upload: %+v %v", res, err)
	}
	entries, err := archive.List(target.ArchiveDir, "youtube")
	if err != nil || len(entries) != 1 {
		t.Fatalf("archived youtube inputs: %+v %v", entries, err)
	}
	for i, e := range entries {
		sub := filepath.Join(dir, "replay", strconv.Itoa(i))
		if err := os.MkdirAll(sub, 0o700); err != nil {
			t.Fatal(err)
		}
		staged, err := archive.Stage(target.ArchiveDir, e, sub)
		if err != nil {
			t.Fatal(err)
		}
		res, err := Run(ctx, target, "youtube", Input{Path: staged})
		if err != nil || res.(youtube.Result).Inserted != 0 {
			t.Fatalf("reimport: %+v %v", res, err)
		}
	}
	if _, err := verify.Run(ctx, st, blobs, target.ArchiveDir, verify.Options{Heal: true}); err != nil {
		t.Fatal(err)
	}

	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages`); n != 1 {
		t.Fatalf("%d messages after replays, want only the subscription", n)
	}
}
