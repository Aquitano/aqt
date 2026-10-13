package whatsapp

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// The Android marker is "<name> (file attached)"; iOS writes "<attached: name>".
const (
	androidChat = "13/05/2024, 21:08 - Alice: IMG-20240513-WA0001.jpg (file attached)\n" +
		"13/05/2024, 21:09 - Alice: did you see it\n"
	iosChat = "[13.05.2024, 21:08:00] Alice: <attached: 00000042-PHOTO-2024-05-13.jpg>\n" +
		"[13.05.2024, 21:09:00] Alice: did you see it\n"
)

func writeExport(t *testing.T, dir, chatName, chat, mediaName string) string {
	t.Helper()
	path := filepath.Join(dir, chatName)
	if err := os.WriteFile(path, []byte(chat), 0o600); err != nil {
		t.Fatal(err)
	}
	if mediaName != "" {
		if err := os.WriteFile(filepath.Join(dir, mediaName), []byte("JPEGBYTES"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func newBlobs(t *testing.T) *blob.Store {
	t.Helper()
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return blobs
}

func TestImportBareTextExportKeepsSiblingMedia(t *testing.T) {
	ctx := context.Background()
	cases := map[string]struct{ chat, media string }{
		"android": {androidChat, "IMG-20240513-WA0001.jpg"},
		"ios":     {iosChat, "00000042-PHOTO-2024-05-13.jpg"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			st := storetest.New(t)
			dir := t.TempDir()
			path := writeExport(t, dir, "WhatsApp Chat with Alice.txt", tc.chat, tc.media)
			res, err := Import(ctx, st, newBlobs(t), filepath.Join(dir, "archive"), path)
			if err != nil {
				t.Fatal(err)
			}
			if res.Inserted != 2 {
				t.Errorf("inserted %d, want 2: %+v", res.Inserted, res)
			}
			if res.Attachments != 1 || res.MissingMedia != 0 {
				t.Errorf("sibling media was not imported: %+v", res)
			}
		})
	}
}

func TestImportBareTextExportRefusesToLeaveTheExportDirectory(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	root := t.TempDir()
	secretPath := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(secretPath, []byte("SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	export := filepath.Join(root, "export")
	if err := os.Mkdir(export, 0o700); err != nil {
		t.Fatal(err)
	}
	// Attachment names are transcript text, so anyone in the chat writes them.
	chat := "13/05/2024, 21:08 - Mallory: ../secret.txt (file attached)\n" +
		"[13.05.2024, 21:09:00] Mallory: <attached: /etc/passwd>\n" +
		"13/05/2024, 21:10 - Mallory: hello\n"
	path := writeExport(t, export, "WhatsApp Chat with Mallory.txt", chat, "")

	res, err := Import(ctx, st, newBlobs(t), filepath.Join(root, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Attachments != 0 {
		t.Fatalf("%d attachments stored from outside the export directory", res.Attachments)
	}
	if res.MissingMedia != 2 {
		t.Errorf("unsafe names should be reported as missing media: %+v", res)
	}
	if n := storetest.CountAttachments(t, dsn); n != 0 {
		t.Errorf("%d attachment rows exist", n)
	}
	if _, err := os.Stat(secretPath); err != nil {
		t.Fatalf("the fixture file vanished: %v", err)
	}
	_ = st
}

func TestImportZipExportStaysInsideTheArchive(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	outside := filepath.Join(dir, "IMG-20240513-WA0001.jpg")
	if err := os.WriteFile(outside, []byte("HOST BYTES"), 0o600); err != nil {
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

	blobs := newBlobs(t)
	res, err := Import(ctx, st, blobs, filepath.Join(dir, "archive"), zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if res.Attachments != 1 {
		t.Fatalf("zip media not imported: %+v", res)
	}
	// The bytes must come from the archive entry, never from the host file
	// that happens to share its name.
	_, atts, err := st.GetMessage(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(atts) != 1 {
		t.Fatalf("attachments = %+v", atts)
	}
	stored, err := os.ReadFile(blobs.Path(atts[0].SHA256))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "ZIP BYTES" {
		t.Errorf("stored %q, want the zip entry's content", stored)
	}
}
