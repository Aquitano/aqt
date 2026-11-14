package linkedin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importer/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

var kind = importer.Register(Source{}, "LinkedIn messages")

func TestImportKeepsConversationsApartAndReportsEmptyRows(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	path := filepath.Join(t.TempDir(), "messages.csv")
	input := `CONVERSATION ID,CONVERSATION TITLE,FROM,TO,DATE,SUBJECT,CONTENT
conv-one,Same title,Alice,Me,2024-01-01 12:00:00 UTC,,hello
conv-two,Same title,Alice,Me,sometime,,hello
conv-two,Same title,Me,Alice,2024-01-01 12:05:00 UTC,,
`
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	got := importtest.MustImport(t, importtest.On(t, st, kind), "linkedin", path, nil)
	if got.Report.Inserted != 2 || got.Report.Issues[ingest.Skipped] != 1 {
		t.Fatalf("report = %+v, want two messages and the empty row skipped", got.Report)
	}
	for _, thread := range []string{"conv-one", "conv-two"} {
		page, err := st.GetThread(ctx, "linkedin", thread, 0)
		if err != nil || len(page.Messages) != 1 {
			t.Fatalf("%s: %+v %v", thread, page, err)
		}
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where thread_id = 'conv-two' and sent_at is null`); n != 1 {
		t.Errorf("%d undated messages have no sent_at, want 1", n)
	}
}
