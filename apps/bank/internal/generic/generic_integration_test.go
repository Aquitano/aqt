package generic

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/fail"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestImportHealsAttachmentsOnReimport(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions, so blob writes cannot be made to fail")
	}
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)

	work := t.TempDir()
	first := filepath.Join(work, "report.pdf")
	second := filepath.Join(work, "sheet.csv")
	for path, content := range map[string]string{first: "PDF", second: "a,b\n1,2\n"} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	blobRoot := filepath.Join(work, "blobs")
	blobs, err := blob.New(blobRoot)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(blobRoot, 0o700) })

	input := []byte(fmt.Sprintf(
		`[{"external_id":"note-1","body":"quarterly report","attachments":[{"path":%q},{"path":%q}]}]`,
		first, second))
	now := time.Date(2024, 5, 13, 21, 8, 0, 0, time.UTC)

	if err := os.Chmod(blobRoot, 0o500); err != nil {
		t.Fatal(err)
	}
	res, err := Import(ctx, st, blobs, "notes", "json/one.json", input, now, true)
	if err == nil {
		t.Fatal("a failing blob store should surface")
	}
	if !fail.IsOp(err) {
		t.Errorf("a blob-store failure must be operational, not a rejected entry: %v", err)
	}
	if res.Inserted != 1 {
		t.Fatalf("the message row should be committed already: %+v", res)
	}
	id, err := st.FindMessageID(ctx, "notes", "note-1")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}

	if err := os.Chmod(blobRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	res, err = Import(ctx, st, blobs, "notes", "json/one.json", input, now, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Duplicates != 1 || res.Healed != 2 {
		t.Fatalf("re-import healed %d of 2 attachments: %+v", res.Healed, res)
	}

	// Losing one row again heals exactly that one.
	_, atts, err := st.GetMessage(ctx, id)
	if err != nil || len(atts) != 2 {
		t.Fatalf("attachments = %+v, err = %v", atts, err)
	}
	storetest.Exec(t, schema, `delete from attachments where id = $1`, atts[1].ID)
	res, err = Import(ctx, st, blobs, "notes", "json/one.json", input, now, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.Healed != 1 {
		t.Errorf("healed %d, want exactly the missing one: %+v", res.Healed, res)
	}
	if _, atts, err = st.GetMessage(ctx, id); err != nil || len(atts) != 2 {
		t.Errorf("%d attachment rows, want 2 with no duplicates (%v)", len(atts), err)
	}
}

func TestImportRejectsWholeInputWithTrailingData(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	input := []byte(`[{"external_id":"a","body":"first"}] {"external_id":"b","body":"second"}`)
	res, err := Import(ctx, st, blobs, "notes", "", input, time.Now(), false)
	if err == nil {
		t.Fatal("trailing data was accepted")
	}
	if res.Inserted != 0 {
		t.Errorf("%d entries inserted before the input was rejected", res.Inserted)
	}
	if id, err := st.FindMessageID(ctx, "notes", "a"); err != nil || id != 0 {
		t.Errorf("the first entry was inserted anyway: %d %v", id, err)
	}
}
