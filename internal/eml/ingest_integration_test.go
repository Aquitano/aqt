package eml

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt-bank/internal/blob"
	"github.com/aquitano/aqt-bank/internal/fail"
	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

const twoAttachmentMail = "From: a@example.com\r\n" +
	"To: b@example.com\r\n" +
	"Subject: two files\r\n" +
	"Date: Mon, 13 May 2024 21:08:00 +0200\r\n" +
	"Message-ID: <two@example.com>\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
	"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsee attached\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"one.pdf\"\r\n\r\nFIRST\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"two.pdf\"\r\n\r\nSECOND\r\n" +
	"--B--\r\n"

// blobStore returns a blob store plus a switch that makes writes fail, which
// is how an import dies between the message row and its bytes in real life
// (a full disk, a read-only mount).
func blobStore(t *testing.T) (*blob.Store, func(writable bool)) {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions, so blob writes cannot be made to fail")
	}
	root := filepath.Join(t.TempDir(), "blobs")
	blobs, err := blob.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(root, 0o700) })
	return blobs, func(writable bool) {
		mode := os.FileMode(0o500)
		if writable {
			mode = 0o700
		}
		if err := os.Chmod(root, mode); err != nil {
			t.Fatal(err)
		}
	}
}

func countAttachments(t *testing.T, st *store.Store, messageID int64) int {
	t.Helper()
	keys, err := st.AttachmentKeys(context.Background(), messageID)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range keys {
		n += c
	}
	return n
}

func TestIngestHealsAttachmentsOnReimport(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, setWritable := blobStore(t)
	raw := []byte(twoAttachmentMail)
	opts := IngestOpts{Source: "proton", RawRef: "proton/two.eml"}

	setWritable(false)
	res, err := Ingest(ctx, st, blobs, raw, opts)
	if err == nil {
		t.Fatal("a failing blob store should surface")
	}
	if !fail.IsOp(err) {
		t.Errorf("a blob-store failure must be operational, not a rejected message: %v", err)
	}
	if !res.Inserted {
		t.Fatal("the message row should already be committed — that is what makes this recoverable")
	}
	id, err := st.FindByEmailMessageID(ctx, "proton", "two@example.com")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}
	if n := countAttachments(t, st, id); n != 0 {
		t.Fatalf("%d attachments stored despite the failure", n)
	}

	setWritable(true)
	res, err = Ingest(ctx, st, blobs, raw, opts)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted {
		t.Error("the message was inserted a second time")
	}
	if res.Healed != 2 || res.Attachments != 2 {
		t.Fatalf("healed %d of 2 attachments (%+v)", res.Healed, res)
	}
	if n := countAttachments(t, st, id); n != 2 {
		t.Fatalf("%d attachment rows, want 2", n)
	}

	// Healing is idempotent: nothing is left to repair, nothing is duplicated.
	res, err = Ingest(ctx, st, blobs, raw, opts)
	if err != nil {
		t.Fatal(err)
	}
	if res.Healed != 0 || countAttachments(t, st, id) != 2 {
		t.Fatalf("a third import changed something: %+v", res)
	}
}

func TestIngestHealsOnlyMissingAttachments(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	blobs, _ := blobStore(t)
	raw := []byte(twoAttachmentMail)
	opts := IngestOpts{Source: "proton", RawRef: "proton/two.eml"}

	if _, err := Ingest(ctx, st, blobs, raw, opts); err != nil {
		t.Fatal(err)
	}
	id, err := st.FindByEmailMessageID(ctx, "proton", "two@example.com")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}
	// Lose one attachment row, the shape a partially stored message has.
	atts, err := st.AttachmentKeys(ctx, id)
	if err != nil || len(atts) != 2 {
		t.Fatalf("keys = %v, err = %v", atts, err)
	}
	_, all, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	storetest.Exec(t, schema, `delete from attachments where id = $1`, all[0].ID)

	res, err := Ingest(ctx, st, blobs, raw, opts)
	if err != nil {
		t.Fatal(err)
	}
	if res.Healed != 1 {
		t.Errorf("healed %d, want exactly the missing one", res.Healed)
	}
	if n := countAttachments(t, st, id); n != 2 {
		t.Errorf("%d attachment rows, want 2 with no duplicates", n)
	}
}
