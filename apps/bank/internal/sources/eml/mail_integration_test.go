package eml

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/search"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestMailboxObservationRecoveryAndFilters(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	target := mailTarget(t, st)
	result := mustImportRaw(t, target, "eml", "message.eml", twoAttachmentMail, EMLOptions{Source: "mail", Mailbox: "Work!"})
	if result.Report.Inserted != 1 {
		t.Fatalf("first import: %+v", result.Report)
	}
	id, err := st.FindByEmailMessageID(ctx, "mail", "two@example.com")
	if err != nil {
		t.Fatal(err)
	}
	before, err := st.GetMessageDetail(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	second := EMLOptions{Source: "mail", Mailbox: "Work"}
	storetest.Exec(t, dsn, "alter table mailbox_messages rename to unavailable_memberships")
	if _, err := importRaw(target, "eml", "message.eml", twoAttachmentMail, second); err == nil {
		t.Fatal("metadata failure was acknowledged")
	}
	storetest.Exec(t, dsn, "alter table unavailable_memberships rename to mailbox_messages")
	result = mustImportRaw(t, target, "eml", "message.eml", twoAttachmentMail, second)
	if result.Report.Duplicates != 1 {
		t.Fatalf("retry: %+v", result.Report)
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
	if hits := storetest.Messages(t, st, "attached", search.Filters{Source: "mail", MailboxID: folders[0].ID, Subject: "two", HasAttachment: &hasAttachment}); len(hits) != 1 {
		t.Fatalf("search: %+v", hits)
	}
	groups, err := st.BrowseThreads(ctx, store.BrowseOpts{Source: "mail", MailboxID: folders[0].ID, Subject: "two", HasAttachment: &hasAttachment, Limit: 20})
	if err != nil || len(groups) != 1 || groups[0].Count != 1 {
		t.Fatalf("browse: %+v, %v", groups, err)
	}
	if _, err := st.BrowseThreads(ctx, store.BrowseOpts{Source: "other", MailboxID: folders[0].ID, Limit: 20}); !errors.Is(err, store.ErrMailboxSource) {
		t.Fatalf("source mismatch: %v", err)
	}
}

func TestGmailIMAPMailJoinsTakeoutThread(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	takeout := "From 1278455344230334865@xxx Mon Aug 03 10:00:00 +0000 2026\r\nX-GM-THRID: 1278455344230334865\r\nX-Gmail-Labels: Inbox\r\nMessage-ID: <takeout@example.com>\r\nSubject: Plans\r\n\r\nfirst\r\n"
	mustImportRaw(t, target, "mbox", "takeout.mbox", takeout, MboxOptions{Mailbox: "Archive"})
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

	collected := "Message-ID: <imap@example.com>\r\nSubject: Re: Plans\r\n\r\nsecond\r\n"
	result := mustImportRaw(t, target, "eml", "collected.eml", collected, EMLOptions{Source: "gmail", Mailbox: "[Gmail]/All Mail", MailboxKind: "imap",
		ThreadID: "11bdfc5cae0c8191", Labels: []string{"INBOX", "Work/Receipts"}})
	if result.Report.Inserted != 1 {
		t.Fatalf("IMAP import: %+v", result.Report)
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
	st := storetest.New(t)
	target := mailTarget(t, st)
	mail := func(name string) string {
		return "X-GM-THRID: 1\r\nMessage-ID: <" + name + "@example.com>\r\nSubject: " + name + "\r\n\r\nbody\r\n"
	}
	mustImportRaw(t, target, "eml", "one.eml", mail("one"), EMLOptions{})
	mustImportRaw(t, target, "mbox", "Inbox", "From a Mon Aug 03 10:00:00 2026\r\n"+mail("two")+"From b Mon Aug 03 10:00:00 2026\r\n"+mail("three"), MboxOptions{Source: "proton"})
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
	threads := map[string]bool{}
	for _, name := range []string{"one", "two", "three"} {
		threads[threadOf(name+"@example.com")] = true
	}
	if len(threads) != 3 || threads["1"] {
		t.Fatalf("unrelated mail joined on a sender's X-GM-THRID: %v", threads)
	}
}
