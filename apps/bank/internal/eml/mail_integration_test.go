package eml

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestContextFreeImportPreservesPOSIXFilenames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("colons and backslashes are POSIX filename characters")
	}
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"receipt:2026.eml", `receipt\2026.eml`} {
		input := filepath.Join(root, name)
		if err := os.WriteFile(input, []byte(twoAttachmentMail), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := ImportEmlPath(ctx, st, blobs, filepath.Join(root, "archive"), "legacy", input); err != nil {
			t.Fatalf("legacy filename %q: %v", name, err)
		}
	}
}

func TestMailContextRecoveryAndFilters(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(root, "message.eml")
	if err := os.WriteFile(input, []byte(twoAttachmentMail), 0o600); err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	observation := &MailImportContext{Version: 1, Kind: "export", Mailbox: "Work!", RelativePath: "Work!/message.eml"}
	result, err := ImportEmlPath(ctx, st, blobs, archiveDir, "mail", input, observation)
	if err != nil || result.Inserted != 1 || result.MailContextVersion != 1 {
		t.Fatalf("first import: %+v, %v", result, err)
	}
	id, err := st.FindByEmailMessageID(ctx, "mail", "two@example.com")
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.GetMessageDetail(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	observation.Mailbox, observation.RelativePath = "Work", "Work/message.eml"
	storetest.Exec(t, schema, "alter table mailbox_messages rename to unavailable_memberships")
	if _, err := ImportEmlPath(ctx, st, blobs, archiveDir, "mail", input, observation); err == nil {
		t.Fatal("metadata failure was acknowledged")
	}
	storetest.Exec(t, schema, "alter table unavailable_memberships rename to mailbox_messages")
	result, err = ImportEmlPath(ctx, st, blobs, archiveDir, "mail", input, observation)
	if err != nil || result.Duplicates != 1 || result.MailContextVersion != 1 {
		t.Fatalf("retry: %+v, %v", result, err)
	}
	after, err := st.GetMessageDetail(ctx, id)
	if err != nil || after.Ref != before.Ref || len(after.Mailboxes) != 2 || len(after.Attachments) != 2 {
		t.Fatalf("canonical message changed: %+v, %v", after, err)
	}
	folders, err := st.ListMailboxes(ctx, "mail")
	if err != nil || len(folders) != 2 || folders[0].Count != 1 || folders[1].Count != 1 {
		t.Fatalf("folders: %+v, %v", folders, err)
	}
	hasAttachment := true
	hits, err := st.Search(ctx, "attached", store.SearchOpts{Source: "mail", MailboxID: folders[0].ID, Subject: "two", HasAttachment: &hasAttachment, Limit: 20})
	if err != nil || len(hits) != 1 {
		t.Fatalf("search: %+v, %v", hits, err)
	}
	groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Source: "mail", MailboxID: folders[0].ID, Subject: "two", HasAttachment: &hasAttachment, Limit: 20})
	if err != nil || len(groups) != 1 || groups[0].Count != 1 {
		t.Fatalf("browse: %+v, %v", groups, err)
	}
	if _, err := st.BrowseThreads(ctx, store.BrowseOpts{Source: "other", MailboxID: folders[0].ID, Limit: 20}); !errors.Is(err, store.ErrMailboxSource) {
		t.Fatalf("source mismatch: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "mail", ".mail-contexts"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("context records: %d, %v", len(entries), err)
	}
	for _, entry := range entries {
		record, err := archive.ReadMailContext(archiveDir, "mail", entry.Name())
		if err != nil || record.Context == nil || record.RawRef == "" {
			t.Fatalf("provenance: %+v, %v", record, err)
		}
	}
}

func TestRemoteMailContextRequiresAcknowledgement(t *testing.T) {
	input := filepath.Join(t.TempDir(), "mail.eml")
	if err := os.WriteFile(input, []byte(twoAttachmentMail), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		_, _ = io.WriteString(writer, `{"inserted":1}`)
	}))
	defer server.Close()
	observation := &MailImportContext{Version: 1, Kind: "imap", Mailbox: "/Archive", RelativePath: "mail.eml"}
	remote := client.New(server.URL, "test")
	if _, err := client.ImportFile[Result](context.Background(), remote, "eml", "mail", input, observation); err == nil {
		t.Fatal("old server falsely acknowledged context")
	}
	if _, err := client.ImportFile[Result](context.Background(), remote, "eml", "mail", input); err != nil {
		t.Fatal(err)
	}
}
