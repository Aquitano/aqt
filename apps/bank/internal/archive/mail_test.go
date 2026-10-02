package archive

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestMailContextPaths(t *testing.T) {
	for _, mailbox := range []string{"/Archive", "Projects/../Notes", "Work!", "Work", "Grüße/收件箱"} {
		observation := MailImportContext{Version: 1, Kind: "imap", Mailbox: mailbox, RelativePath: "message.eml"}
		if err := observation.Validate(); err != nil {
			t.Fatalf("opaque mailbox %q: %v", mailbox, err)
		}
	}
	for _, relative := range []string{"", "/mail.eml", "../mail.eml", "a/../b", `C:\mail.eml`, `a\..\b`, "a\x00b"} {
		observation := MailImportContext{Version: 1, Kind: "export", Mailbox: "Work", RelativePath: relative}
		if err := observation.Validate(); err == nil {
			t.Fatalf("unsafe relative path accepted: %q", relative)
		}
	}
	for _, raw := range []string{"other/mail.eml", "mail/../other.eml", "/mail/mail.eml", "mail/.mail-contexts/record.json"} {
		if err := (MailContextRecord{Version: 1, Source: "mail", RawRef: raw, InputKind: "eml"}).Validate(); err == nil {
			t.Fatalf("unsafe raw reference: %q", raw)
		}
	}
}

func TestMailContextEscapedValuesRoundTrip(t *testing.T) {
	root := t.TempDir()
	reference, err := Write(root, "mail", "input.eml", []byte("Subject: example\n\nbody"))
	if err != nil {
		t.Fatal(err)
	}
	record := MailContextRecord{Version: 1, Source: "mail", RawRef: reference, InputKind: "eml", ExternalID: strings.Repeat("<", 4096), ThreadID: strings.Repeat("&", 4096), Context: &MailImportContext{Version: 1, Kind: "export", Mailbox: "Work", RelativePath: "input.eml"}}
	path, err := WriteMailContext(root, record)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := ReadMailContext(root, "mail", filepath.Base(path))
	if err != nil || restored.ExternalID != record.ExternalID || restored.ThreadID != record.ThreadID {
		t.Fatalf("escaped record failed round trip: %v", err)
	}
}

func TestArchivePublicationFailureAndRetry(t *testing.T) {
	root := t.TempDir()
	injected := errors.New("publication barrier failed")
	publish := func(oldPath, newPath string) error {
		if err := os.Rename(oldPath, newPath); err != nil {
			return err
		}
		return injected
	}
	if _, err := writePublished(root, "mail/input.eml", bytes.NewBufferString("mail"), publish, syncArchiveFile); !errors.Is(err, injected) {
		t.Fatalf("failed publication acknowledged: %v", err)
	}
	if _, err := writePublished(root, "mail/input.eml", bytes.NewBufferString("mail"), publish, func(string) error { return injected }); !errors.Is(err, injected) {
		t.Fatalf("retry skipped barrier: %v", err)
	}
	if _, err := Write(root, "mail", "input.eml", []byte("mail")); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentArchiveDirectoryPublication(t *testing.T) {
	root := filepath.Join(t.TempDir(), "new", "archive")
	var workers sync.WaitGroup
	failures := make(chan error, 8)
	for range 8 {
		workers.Go(func() { _, err := Write(root, "mail", "input.eml", []byte("mail")); failures <- err })
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
}
