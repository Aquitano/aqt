package whatsapp

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// The Android marker is "<name> (file attached)"; iOS writes "<attached: name>".
const (
	androidChat = "13/05/2024, 21:08 - Alice: IMG-20240513-WA0001.jpg (file attached)\n" +
		"13/05/2024, 21:09 - Alice: did you see it\n"
	iosChat = "[13.05.2024, 21:08:00] Alice: <attached: 00000042-PHOTO-2024-05-13.jpg>\n" +
		"[13.05.2024, 21:09:00] Alice: did you see it\n"
)

var kind = importer.Register(Source{}, "WhatsApp")

func writeExport(t *testing.T, dir, chat, mediaName string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "WhatsApp Chat with Alice.txt"), []byte(chat), 0o600); err != nil {
		t.Fatal(err)
	}
	if mediaName != "" {
		if err := os.WriteFile(filepath.Join(dir, mediaName), []byte("JPEGBYTES"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// A directory is packed into one raw input, so its media is still there when
// the input is replayed into an empty archive.
func TestDirectoryExportReplaysWithItsMedia(t *testing.T) {
	cases := map[string]struct{ chat, media string }{
		"android": {androidChat, "IMG-20240513-WA0001.jpg"},
		"ios":     {iosChat, "00000042-PHOTO-2024-05-13.jpg"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			st, dsn := storetest.NewNamed(t)
			target := importtest.On(t, st, kind)
			dir := filepath.Join(t.TempDir(), "WhatsApp Chat with Alice")
			writeExport(t, dir, tc.chat, tc.media)
			got := importtest.MustImport(t, target, "whatsapp", dir, nil)
			if got.Name != "WhatsApp Chat with Alice.zip" || got.Report.Inserted != 2 || got.Report.Attachments != 1 || got.Status != "complete" {
				t.Fatalf("import: %+v", got)
			}
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			storetest.Exec(t, dsn, `delete from messages`)
			var replayed []store.RawInput
			if err := importer.Replay(context.Background(), target, nil, func(r store.RawInput, err error) {
				if err != nil {
					t.Fatal(err)
				}
				replayed = append(replayed, r)
			}); err != nil {
				t.Fatal(err)
			}
			if len(replayed) != 1 || replayed[0].Report.Inserted != 2 || replayed[0].Report.Attachments != 1 {
				t.Fatalf("replay: %+v", replayed)
			}
			hits, err := st.Search(context.Background(), "see", store.SearchOpts{Limit: 10})
			if err != nil || len(hits) != 1 || hits[0].ThreadID != "Alice" {
				t.Fatalf("thread after replay: %+v %v", hits, err)
			}
		})
	}
}

func TestUnsafeAttachmentNamesStayMissing(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "secret.txt"), []byte("SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Attachment names are transcript text, so anyone in the chat writes them.
	chat := "13/05/2024, 21:08 - Mallory: ../secret.txt (file attached)\n" +
		"[13.05.2024, 21:09:00] Mallory: <attached: /etc/passwd>\n" +
		"13/05/2024, 21:10 - Mallory: hello\n"
	dir := filepath.Join(root, "export")
	writeExport(t, dir, chat, "")
	got := importtest.MustImport(t, importtest.On(t, st, kind), "whatsapp", dir, nil)
	if got.Report.Attachments != 0 || got.Report.Issues[ingest.MissingMedia] != 2 || got.Status != "gaps" {
		t.Fatalf("unsafe names should be missing media: %+v", got)
	}
	if n := storetest.CountAttachments(t, dsn); n != 0 {
		t.Errorf("%d attachment rows exist", n)
	}
}

func TestZipExportStaysInsideTheArchive(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "IMG-20240513-WA0001.jpg"), []byte("HOST BYTES"), 0o600); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(dir, "WhatsApp Chat with Alice.zip")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	add := func(name, content string) {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	add("_chat.txt", androidChat)
	add("IMG-20240513-WA0001.jpg", "ZIP BYTES")
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()

	target := importtest.On(t, st, kind)
	got := importtest.MustImport(t, target, "whatsapp", zipPath, nil)
	if got.Report.Attachments != 1 {
		t.Fatalf("zip media not imported: %+v", got)
	}
	hits, err := st.Search(ctx, "see", store.SearchOpts{Limit: 10})
	if err != nil || len(hits) != 1 {
		t.Fatalf("search: %+v %v", hits, err)
	}
	thread, err := st.GetThreadPage(ctx, "whatsapp", "Alice", store.ThreadOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	atts := thread.Messages[0].Attachments
	if len(atts) != 1 {
		t.Fatalf("attachments = %+v", atts)
	}
	stored, err := os.ReadFile(target.Blobs.Path(atts[0].BLAKE3))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "ZIP BYTES" {
		t.Errorf("stored %q, want the zip entry's content", stored)
	}
}
