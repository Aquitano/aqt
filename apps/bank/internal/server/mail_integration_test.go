package server

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/eml"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestMailImportContextAndThreadConflictHTTP(t *testing.T) {
	ctx := context.Background()
	server, database := attachmentServer(t)
	token, err := NewToken(server.dataDir, "mail-test")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	remote := client.New(httpServer.URL, token)
	input := filepath.Join(t.TempDir(), "mail.eml")
	root := []byte("Message-ID: <root@example.com>\r\nSubject: Invoice\r\n\r\nroot")
	if err := os.WriteFile(input, root, 0600); err != nil {
		t.Fatal(err)
	}
	for index, mailbox := range []string{"Work!", "Work"} {
		observation := &eml.MailImportContext{Version: 1, Kind: "export", Mailbox: mailbox, RelativePath: "mail.eml"}
		result, err := client.ImportFile[eml.Result](ctx, remote, "eml", "mail", input, observation)
		if err != nil || result.MailContextVersion != 1 || result.Inserted != 1-index || result.Duplicates != index {
			t.Fatalf("upload: %+v %v", result, err)
		}
	}
	mailboxes, err := remote.ListMailboxes(ctx, "mail")
	if err != nil || len(mailboxes) != 2 {
		t.Fatalf("mailboxes: %+v %v", mailboxes, err)
	}
	child := []byte("Message-ID: <child@example.com>\r\nIn-Reply-To: <root@example.com>\r\nSubject: Reply\r\n\r\nchild")
	if _, err := eml.Ingest(ctx, database, server.blobs, child, eml.IngestOpts{Source: "mail"}); err != nil {
		t.Fatal(err)
	}
	groups, err := remote.BrowseThreads(ctx, store.BrowseOpts{Source: "mail", MailboxID: mailboxes[0].ID, Subject: "invoice", Limit: 10})
	if err != nil || len(groups) != 1 || groups[0].Count != 1 {
		t.Fatalf("filtered groups: %+v %v", groups, err)
	}
	thread, err := remote.GetThreadPage(ctx, "mail", groups[0].ThreadID, store.ThreadOpts{Limit: 10})
	if err != nil || len(thread.Messages) != 2 {
		t.Fatalf("full conversation: %+v %v", thread, err)
	}
	if _, err := eml.Ingest(ctx, database, server.blobs, root, eml.IngestOpts{Source: "mail", ThreadID: "provider-one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := eml.Ingest(ctx, database, server.blobs, child, eml.IngestOpts{Source: "mail", ThreadID: "provider-two"}); err != nil {
		t.Fatal(err)
	}
	_, err = remote.GetThreadPage(ctx, "mail", groups[0].ThreadID, store.ThreadOpts{Limit: 10})
	var conflict *store.MailThreadConflictError
	if !errors.As(err, &conflict) || len(conflict.Choices) != 2 {
		t.Fatalf("HTTP conflict not typed: %v", err)
	}
	page, err := remote.MailConflictMessages(ctx, "mail", conflict.ConflictKey, 0, 10)
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("unanchored route: %+v %v", page, err)
	}
	status, _ := authedGet(t, httpServer, token, "/v1/threads?person=missing&limit=10")
	if status != 400 {
		t.Fatalf("unknown filter contact returned %d", status)
	}
}
