package verify

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/whatsapp"
)

const mailWithAttachments = "From: a@example.com\r\n" +
	"Subject: two files\r\n" +
	"Date: Mon, 13 May 2024 21:08:00 +0200\r\n" +
	"Message-ID: <two@example.com>\r\n" +
	"MIME-Version: 1.0\r\n" +
	"Content-Type: multipart/mixed; boundary=B\r\n\r\n" +
	"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nsee attached\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"one.pdf\"\r\n\r\nFIRST\r\n" +
	"--B\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"two.pdf\"\r\n\r\nSECOND\r\n" +
	"--B--\r\n"

type fixture struct {
	st         *store.Store
	schema     string
	blobs      *blob.Store
	archiveDir string
	messageID  int64
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	raw := []byte(mailWithAttachments)
	rawRef, err := archive.Write(archiveDir, "proton", "two.eml", raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eml.Ingest(ctx, st, blobs, raw, eml.IngestOpts{Source: "proton", RawRef: rawRef}); err != nil {
		t.Fatal(err)
	}
	id, err := st.FindByEmailMessageID(ctx, "proton", "two@example.com")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}
	return &fixture{st: st, schema: schema, blobs: blobs, archiveDir: archiveDir, messageID: id}
}

func (f *fixture) run(t *testing.T, heal bool) Report {
	t.Helper()
	rep, err := Run(context.Background(), f.st, f.blobs, f.archiveDir, Options{Heal: heal})
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func (f *fixture) attachments(t *testing.T) []store.Attachment {
	t.Helper()
	_, atts, err := f.st.GetMessage(context.Background(), f.messageID)
	if err != nil {
		t.Fatal(err)
	}
	return atts
}

func kinds(rep Report) map[string]int {
	out := map[string]int{}
	for _, f := range rep.Findings {
		out[f.Kind]++
	}
	return out
}

func TestHealthyArchiveHasNoFindings(t *testing.T) {
	f := newFixture(t)
	rep := f.run(t, false)
	if rep.Damaged != 0 || len(rep.Findings) != 0 {
		t.Fatalf("a freshly imported archive reported damage: %+v", rep.Findings)
	}
	if rep.MessagesChecked != 1 || rep.AttachmentsChecked != 2 {
		t.Errorf("checked %d messages / %d attachments", rep.MessagesChecked, rep.AttachmentsChecked)
	}
}

func TestMissingBlobIsFoundAndHealed(t *testing.T) {
	f := newFixture(t)
	gone := f.attachments(t)[0]
	if err := os.Remove(f.blobs.Path(gone.SHA256)); err != nil {
		t.Fatal(err)
	}

	rep := f.run(t, false)
	if kinds(rep)[MissingBlob] != 1 || rep.Repaired != 0 {
		t.Fatalf("read-only pass = %+v", rep)
	}
	if _, err := os.Stat(f.blobs.Path(gone.SHA256)); err == nil {
		t.Fatal("the read-only pass wrote to the blob store")
	}

	rep = f.run(t, true)
	if rep.Repaired != 1 || rep.Unrecoverable != 0 {
		t.Fatalf("heal = %+v", rep)
	}
	if _, err := os.Stat(f.blobs.Path(gone.SHA256)); err != nil {
		t.Fatalf("the blob was not restored: %v", err)
	}
	if rep := f.run(t, true); rep.Damaged != 0 {
		t.Errorf("healing is not idempotent: %+v", rep.Findings)
	}
}

func TestCorruptBlobIsFoundAndHealed(t *testing.T) {
	f := newFixture(t)
	a := f.attachments(t)[1]
	if err := os.WriteFile(f.blobs.Path(a.SHA256), []byte("TAMPERED"), 0o600); err != nil {
		t.Fatal(err)
	}
	if k := kinds(f.run(t, false)); k[CorruptBlob] != 1 {
		t.Fatalf("corruption not detected: %v", k)
	}
	if rep := f.run(t, true); rep.Repaired != 1 {
		t.Fatalf("heal = %+v", rep)
	}
	content, err := os.ReadFile(f.blobs.Path(a.SHA256))
	if err != nil || string(content) != "SECOND" {
		t.Fatalf("content = %q, %v", content, err)
	}
}

func TestWrongSizeIsHealedWithoutTheRawInput(t *testing.T) {
	f := newFixture(t)
	a := f.attachments(t)[0]
	storetest.Exec(t, f.schema, `update attachments set size_bytes = 99999 where id = $1`, a.ID)

	if k := kinds(f.run(t, false)); k[WrongSize] != 1 {
		t.Fatalf("a lying size_bytes was not detected: %v", k)
	}
	if rep := f.run(t, true); rep.Repaired != 1 {
		t.Fatalf("heal = %+v", rep)
	}
	if got := f.attachments(t)[0].SizeBytes; got != a.SizeBytes {
		t.Errorf("size_bytes = %d, want %d", got, a.SizeBytes)
	}
}

func TestMissingAttachmentRowIsFoundAndHealed(t *testing.T) {
	f := newFixture(t)
	lost := f.attachments(t)[0]
	storetest.Exec(t, f.schema, `delete from attachments where id = $1`, lost.ID)

	if k := kinds(f.run(t, false)); k[MissingAttachments] != 1 {
		t.Fatalf("a message missing an attachment row was not detected: %v", k)
	}
	if rep := f.run(t, true); rep.Repaired != 1 {
		t.Fatalf("heal = %+v", rep)
	}
	atts := f.attachments(t)
	if len(atts) != 2 {
		t.Fatalf("%d attachment rows, want 2", len(atts))
	}
	if rep := f.run(t, true); rep.Damaged != 0 {
		t.Errorf("re-healing duplicated rows: %+v", rep.Findings)
	}
}

// WhatsApp media lives in the export zip, not in a mail — the digest match
// against the zip's own files is what makes it healable.
func TestWhatsAppZipMediaIsHealed(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}

	zipPath := filepath.Join(root, "WhatsApp Chat with Alice.zip")
	zf, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(zf)
	for name, content := range map[string]string{
		"_chat.txt":               "13/05/2024, 21:08 - Alice: IMG-20240513-WA0001.jpg (file attached)\n",
		"IMG-20240513-WA0001.jpg": "JPEG BYTES",
	} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zf.Close()

	archiveDir := filepath.Join(root, "archive")
	res, err := whatsapp.Import(ctx, st, blobs, archiveDir, zipPath)
	if err != nil || res.Attachments != 1 {
		t.Fatalf("import = %+v, %v", res, err)
	}
	msgID := storetest.QueryInt(t, schema, `select message_id from attachments limit 1`)
	_, atts, err := st.GetMessage(ctx, msgID)
	if err != nil || len(atts) != 1 {
		t.Fatalf("attachments = %v, %v", atts, err)
	}
	if err := os.Remove(blobs.Path(atts[0].SHA256)); err != nil {
		t.Fatal(err)
	}

	rep, err := Run(ctx, st, blobs, archiveDir, Options{Heal: true})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Repaired != 1 || rep.Unrecoverable != 0 {
		t.Fatalf("heal = %+v", rep)
	}
	if _, err := os.Stat(blobs.Path(atts[0].SHA256)); err != nil {
		t.Fatalf("media not restored from the export zip: %v", err)
	}
}

// An mbox carries the exact original mail; a blob lost from a message imported
// out of one is healable by re-splitting and matching the digest.
func TestMboxAttachmentIsHealed(t *testing.T) {
	ctx := context.Background()
	st, _ := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	mbox := "From a@example.com Mon May 13 21:08:00 2024\n" + mailWithAttachments
	rawRef, err := archive.Write(archiveDir, "gmail", "takeout.mbox", []byte(mbox))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eml.Ingest(ctx, st, blobs, []byte(mailWithAttachments), eml.IngestOpts{Source: "gmail", RawRef: rawRef}); err != nil {
		t.Fatal(err)
	}
	id, err := st.FindByEmailMessageID(ctx, "gmail", "two@example.com")
	if err != nil || id == 0 {
		t.Fatalf("message not found: %d %v", id, err)
	}
	_, atts, err := st.GetMessage(ctx, id)
	if err != nil || len(atts) == 0 {
		t.Fatalf("attachments = %v, %v", atts, err)
	}
	if err := os.Remove(blobs.Path(atts[0].SHA256)); err != nil {
		t.Fatal(err)
	}

	rep, err := Run(ctx, st, blobs, archiveDir, Options{Heal: true})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Repaired != 1 || rep.Unrecoverable != 0 {
		t.Fatalf("heal = %+v", rep)
	}
	if _, err := os.Stat(blobs.Path(atts[0].SHA256)); err != nil {
		t.Fatalf("attachment not restored from the mbox: %v", err)
	}
}

func TestMissingRawInputIsUnrecoverable(t *testing.T) {
	f := newFixture(t)
	a := f.attachments(t)[0]
	if err := os.RemoveAll(f.archiveDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(f.blobs.Path(a.SHA256)); err != nil {
		t.Fatal(err)
	}

	rep := f.run(t, true)
	k := kinds(rep)
	if k[MissingRaw] != 1 || k[MissingBlob] != 1 {
		t.Fatalf("findings = %v", k)
	}
	if rep.Repaired != 0 || rep.Unrecoverable != 2 {
		t.Errorf("nothing can be rebuilt without the raw input: %+v", rep)
	}
}
