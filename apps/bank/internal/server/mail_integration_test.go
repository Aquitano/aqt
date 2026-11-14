package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestMailboxObservationsAndThreadConflictHTTP(t *testing.T) {
	ctx := context.Background()
	server, _ := attachmentServer(t)
	token, err := Tokens(server.dataDir).New("mail-test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()
	remote := client.New(httpServer.URL, token)
	root := "Message-ID: <root@example.com>\r\nSubject: Invoice\r\n\r\nroot"
	child := "Message-ID: <child@example.com>\r\nIn-Reply-To: <root@example.com>\r\nSubject: Reply\r\n\r\nchild"
	importMail := func(name, body, options string) store.RawInput {
		t.Helper()
		raw, err := importUpload(ctx, remote, "eml", name, strings.NewReader(body), json.RawMessage(options))
		if err != nil {
			t.Fatalf("import %s %s: %v", name, options, err)
		}
		return raw
	}
	for index, mailbox := range []string{"Work!", "Work"} {
		raw := importMail("mail.eml", root, `{"source": "mail", "mailbox": "`+mailbox+`"}`)
		if raw.Report.Inserted != 1-index || raw.Report.Duplicates != index {
			t.Fatalf("upload to %s: %+v", mailbox, raw.Report)
		}
	}
	mailboxes, err := client.Call(ctx, remote, ListMailboxes, MailboxesInput{Source: "mail"})
	if err != nil || len(mailboxes) != 2 {
		t.Fatalf("mailboxes: %+v %v", mailboxes, err)
	}
	importMail("child.eml", child, `{"source": "mail"}`)
	groups, err := client.Call(ctx, remote, ListThreads, ListThreadsInput{Source: "mail", MailboxID: mailboxes[0].ID, Subject: "invoice", Page: httpapi.Page{PageSize: httpapi.PageSize{Limit: 10}}})
	if err != nil || len(groups) != 1 || groups[0].Count != 1 {
		t.Fatalf("filtered groups: %+v %v", groups, err)
	}
	thread, err := client.Call(ctx, remote, GetThread, ThreadInput{Source: "mail", ID: groups[0].ThreadID, PageSize: httpapi.PageSize{Limit: 10}})
	if err != nil || len(thread.Messages) != 2 {
		t.Fatalf("full conversation: %+v %v", thread, err)
	}
	for _, message := range thread.Messages {
		cited, err := ref.ParseMessage(message.Ref)
		if err != nil {
			t.Fatal(err)
		}
		detail, err := client.Call(ctx, remote, GetMessage, MessageInput{Ref: cited})
		if err != nil || detail.Mail == nil || message.Mail == nil || !detail.Mail.HasReplyLinks || !message.Mail.HasReplyLinks {
			t.Fatalf("mail provenance missing over HTTP: %+v %v", detail, err)
		}
		if message.MessageID == "root@example.com" && (detail.RawInput == 0 || detail.Mail.RawInput == 0 || len(detail.Mailboxes) != 2) {
			t.Fatalf("raw input or folder provenance lost: %+v", detail)
		}
	}
	importMail("mail.eml", root, `{"source": "mail", "thread_id": "provider-one"}`)
	importMail("child.eml", child, `{"source": "mail", "thread_id": "provider-two"}`)
	_, err = client.Call(ctx, remote, GetThread, ThreadInput{Source: "mail", ID: groups[0].ThreadID, PageSize: httpapi.PageSize{Limit: 10}})
	var conflict *store.MailThreadConflictError
	if !errors.As(err, &conflict) || len(conflict.Choices) != 2 {
		t.Fatalf("HTTP conflict not typed: %v", err)
	}
	for _, choice := range conflict.Choices {
		page, err := client.Call(ctx, remote, GetThread, ThreadInput{Source: "mail", ID: choice, Current: true, PageSize: httpapi.PageSize{Limit: 10}})
		if err != nil || len(page.Messages) != 1 || page.Messages[0].Mail == nil || page.Messages[0].Mail.ConflictKey == "" || page.Messages[0].Mail.NativeThreadID != choice {
			t.Fatalf("provider conflict provenance: %+v %v", page, err)
		}
	}
	page, err := client.Call(ctx, remote, GetMailConflict, MailConflictInput{Source: "mail", Key: conflict.ConflictKey, PageSize: httpapi.PageSize{Limit: 10}})
	if err != nil || len(page.Messages) != 0 {
		t.Fatalf("unanchored route: %+v %v", page, err)
	}
	status, _ := authedGet(t, httpServer, token, "/v1/threads?person=missing&limit=10")
	if status != 422 {
		t.Fatalf("unknown filter contact returned %d", status)
	}
}
