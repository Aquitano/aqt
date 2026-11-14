package generic

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importer/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

var kind = importer.Register(Source{}, "JSON messages")

func writeInput(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "notes.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestImportStoresBase64AttachmentsAndUnknownDates(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := importtest.On(t, st, kind)
	path := writeInput(t, `[{"external_id":"note-1","body":"quarterly report","attachments":[
		{"filename":"report.pdf","data":"UERG"},
		{"filename":"sheet.csv","mime_type":"text/csv","data":"YSxiCjEsMgo="}]}]`)

	got := importtest.MustImport(t, target, "json", path, Options{Source: "notes"})
	if got.Report.Inserted != 1 || got.Report.Attachments != 2 || got.Status != "complete" {
		t.Fatalf("import: %+v", got)
	}
	id, err := st.FindMessageID(ctx, "notes", "note-1")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}
	m, atts, err := st.GetMessage(ctx, id)
	if err != nil || len(atts) != 2 {
		t.Fatalf("attachments = %+v, err = %v", atts, err)
	}
	if !m.SentAt.IsZero() {
		t.Errorf("a missing sent_at was stored as %v", m.SentAt)
	}
	for i, want := range []string{"PDF", "a,b\n1,2\n"} {
		stored, err := os.ReadFile(target.Blobs.Path(atts[i].BLAKE3))
		if err != nil {
			t.Fatal(err)
		}
		if string(stored) != want {
			t.Errorf("attachment %d stored %q, want %q", i, stored, want)
		}
	}
	if atts[1].MimeType != "text/csv" {
		t.Errorf("mime type %q, want the one the entry gave", atts[1].MimeType)
	}
}

func TestImportRejectsWholeInputWithTrailingData(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := importtest.On(t, st, kind)
	path := writeInput(t, `[{"external_id":"a","body":"first"}] {"external_id":"b","body":"second"}`)
	got, err := importtest.Import(t, target, "json", path, Options{Source: "notes"})
	if err == nil {
		t.Fatal("trailing data was accepted")
	}
	if got.Status != "failed" {
		t.Errorf("status %q, want failed", got.Status)
	}
	if id, err := st.FindMessageID(ctx, "notes", "a"); err != nil || id != 0 {
		t.Errorf("the first entry was inserted anyway: %d %v", id, err)
	}
}
