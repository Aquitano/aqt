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
	"slices"
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
	st, dsn := storetest.NewNamed(t)
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
	storetest.Exec(t, dsn, "alter table mailbox_messages rename to unavailable_memberships")
	if _, err := ImportEmlPath(ctx, st, blobs, archiveDir, "mail", input, observation); err == nil {
		t.Fatal("metadata failure was acknowledged")
	}
	storetest.Exec(t, dsn, "alter table unavailable_memberships rename to mailbox_messages")
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
	versionOne := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		_, _ = io.WriteString(writer, `{"inserted":1,"mail_context_version":1}`)
	}))
	defer versionOne.Close()
	gmail := &MailImportContext{Version: 2, Kind: "imap", Mailbox: "INBOX", RelativePath: "mail.eml", ThreadID: "11bdfc5cae0c8191"}
	if _, err := client.ImportFile[Result](context.Background(), client.New(versionOne.URL, "test"), "eml", "gmail", input, gmail); err == nil {
		t.Fatal("version 1 acknowledgement accepted for a version 2 context")
	}
}

func TestGmailIMAPMailJoinsTakeoutThread(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	takeout := filepath.Join(root, "takeout.mbox")
	if err := os.WriteFile(takeout, []byte("From 1278455344230334865@xxx Mon Aug 03 10:00:00 +0000 2026\r\nX-GM-THRID: 1278455344230334865\r\nX-Gmail-Labels: Inbox\r\nMessage-ID: <takeout@example.com>\r\nSubject: Plans\r\n\r\nfirst\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportMbox(ctx, st, blobs, archiveDir, "gmail", takeout, &MailImportContext{Version: 1, Kind: "export", Mailbox: "Archive", RelativePath: "takeout.mbox"}); err != nil {
		t.Fatal(err)
	}
	threadOf := func(messageID string) string {
		t.Helper()
		id, err := st.FindByEmailMessageID(ctx, "gmail", messageID)
		if err != nil {
			t.Fatal(err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return message.ThreadID
	}
	if thread := threadOf("takeout@example.com"); thread != "11bdfc5cae0c8191" {
		t.Fatalf("Takeout thread = %q, want the Gmail API form", thread)
	}
	storetest.Exec(t, dsn, `update mail_details set native_thread_id=''; update messages set thread_id='mail:before-takeout-thread-ids'`)
	if _, err := RebuildMail(ctx, st, archiveDir, "gmail", true); err != nil {
		t.Fatal(err)
	}
	if thread := threadOf("takeout@example.com"); thread != "11bdfc5cae0c8191" {
		t.Fatalf("rebuilt Takeout thread = %q", thread)
	}

	collected := filepath.Join(root, "collected.eml")
	if err := os.WriteFile(collected, []byte("Message-ID: <imap@example.com>\r\nSubject: Re: Plans\r\n\r\nsecond\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	observation := &MailImportContext{Version: 2, Kind: "imap", Mailbox: "[Gmail]/All Mail", RelativePath: "collected.eml", AccountID: "gmail-personal", ThreadID: "11bdfc5cae0c8191", Labels: []string{"INBOX", "Work/Receipts"}}
	result, err := ImportEmlPath(ctx, st, blobs, archiveDir, "gmail", collected, observation)
	if err != nil || result.Inserted != 1 || result.MailContextVersion != 2 {
		t.Fatalf("IMAP import: %+v, %v", result, err)
	}
	if thread := threadOf("imap@example.com"); thread != "11bdfc5cae0c8191" {
		t.Fatalf("IMAP thread = %q, want the Takeout thread", thread)
	}
	folders, err := st.ListMailboxes(ctx, "gmail")
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, folder := range folders {
		paths = append(paths, folder.Kind+":"+folder.Path)
	}
	slices.Sort(paths)
	if !slices.Equal(paths, []string{"export:Archive", "imap:INBOX", "imap:Work/Receipts", "imap:[Gmail]/All Mail"}) {
		t.Fatalf("label observations = %v", paths)
	}
}

func TestSenderThreadHeaderOutsideTakeoutIsIgnored(t *testing.T) {
	ctx := context.Background()
	st, _ := storetest.NewNamed(t)
	root := t.TempDir()
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(root, "archive")
	mail := func(name string) string {
		return "X-GM-THRID: 1\r\nMessage-ID: <" + name + "@example.com>\r\nSubject: " + name + "\r\n\r\nbody\r\n"
	}
	eml, tree := filepath.Join(root, "one.eml"), filepath.Join(root, "Inbox")
	if err := os.WriteFile(eml, []byte(mail("one")), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tree, []byte("From a Mon Aug 03 10:00:00 2026\r\n"+mail("two")+"From b Mon Aug 03 10:00:00 2026\r\n"+mail("three")), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportEmlPath(ctx, st, blobs, archiveDir, "proton", eml); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportMbox(ctx, st, blobs, archiveDir, "proton", tree); err != nil {
		t.Fatal(err)
	}
	threadOf := func(messageID string) string {
		t.Helper()
		id, err := st.FindByEmailMessageID(ctx, "proton", messageID)
		if err != nil {
			t.Fatal(err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return message.ThreadID
	}
	for _, step := range []string{"import", "rebuild"} {
		if step == "rebuild" {
			if _, err := RebuildMail(ctx, st, archiveDir, "proton", true); err != nil {
				t.Fatal(err)
			}
		}
		threads := map[string]bool{}
		for _, name := range []string{"one", "two", "three"} {
			threads[threadOf(name+"@example.com")] = true
		}
		if len(threads) != 3 || threads["1"] {
			t.Fatalf("%s joined unrelated mail on a sender's X-GM-THRID: %v", step, threads)
		}
	}
}
