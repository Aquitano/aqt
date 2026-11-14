package eml

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestMalformedMessageIDDoesNotBlockImport(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	for index, messageID := range []string{"bad\x00@example.com", "bad\xff@example.com", "bad\x01@example.com"} {
		options := EMLOptions{Source: "malformed", ExternalID: fmt.Sprintf("mail%d", index)}
		for range 2 {
			raw := mustImportRaw(t, target, "eml", "malformed.eml", "Message-ID: "+messageID+"\r\n\r\nbody", options)
			if raw.Report.Inserted+raw.Report.Duplicates != 1 || raw.Report.Issues[ingest.Damaged] == 0 {
				t.Fatalf("invalid ID wedged import: %+v", raw.Report)
			}
		}
		id, err := st.FindMessageID(ctx, options.Source, options.ExternalID)
		if err != nil {
			t.Fatal(err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil || message.Mail == nil || message.Mail.MessageID != "" || message.Body != "body" {
			t.Fatalf("malformed message not retained safely: %+v %v", message, err)
		}
	}
}

// A reply that names only its direct parent can arrive before the mail that
// links it to the root. Every order must still end in one thread.
func TestMailThreadsDoNotDependOnArrivalOrder(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	raw := map[string]string{
		"a":         "Message-ID: <a@example.com>\r\nSubject: Plans\r\n\r\nroot",
		"b":         "Message-ID: <b@example.com>\r\nReferences: <a@example.com>\r\nSubject: Re: Plans\r\n\r\nreply",
		"c":         "Message-ID: <c@example.com>\r\nIn-Reply-To: <b@example.com>\r\nSubject: Re: Plans\r\n\r\nreply",
		"d":         "Message-ID: <d@example.com>\r\nIn-Reply-To: <missing@example.com>\r\nSubject: Re: Lunch\r\n\r\nsibling",
		"e":         "Message-ID: <e@example.com>\r\nIn-Reply-To: <missing@example.com>\r\nSubject: Re: Lunch\r\n\r\nsibling",
		"unrelated": "Message-ID: <unrelated@example.com>\r\nSubject: Re: Plans\r\n\r\nunrelated",
		"gmail":     "Message-ID: <gmail@example.com>\r\nIn-Reply-To: <a@example.com>\r\nSubject: Re: Plans\r\n\r\nprovider",
	}
	for index, order := range [][]string{{"a", "b", "c"}, {"a", "c", "b"}, {"b", "a", "c"}, {"b", "c", "a"}, {"c", "a", "b"}, {"c", "b", "a"}} {
		source := fmt.Sprintf("order%d", index)
		for _, name := range append(order, "d", "e", "unrelated") {
			mustImportRaw(t, target, "eml", name+".eml", raw[name], EMLOptions{Source: source})
		}
		mustImportRaw(t, target, "eml", "gmail.eml", raw["gmail"], EMLOptions{Source: source, ThreadID: "gmail-thread"})
		threads := map[string]string{}
		for name := range raw {
			id, err := st.FindByEmailMessageID(ctx, source, name+"@example.com")
			if err != nil {
				t.Fatal(err)
			}
			message, err := st.GetMessageDetail(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			threads[name] = message.ThreadID
		}
		if threads["a"] != threads["b"] || threads["b"] != threads["c"] || threads["d"] != threads["e"] {
			t.Fatalf("order %v split a conversation: %v", order, threads)
		}
		if threads["unrelated"] == threads["a"] || threads["d"] == threads["a"] || threads["gmail"] != "gmail-thread" {
			t.Fatalf("order %v merged unrelated mail: %v", order, threads)
		}
		thread, err := st.GetThread(ctx, source, threads["a"], 10)
		if err != nil || len(thread.Messages) != 3 {
			t.Fatalf("order %v thread page: %+v %v", order, thread, err)
		}
	}
}

func TestConcurrentMailObservationsAndNormalizedNodes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	var workers sync.WaitGroup
	errorsOut := make(chan error, 4)
	for index := range 4 {
		workers.Go(func() {
			_, err := importRaw(target, "eml", "input.eml", twoAttachmentMail, EMLOptions{Source: "concurrent", ThreadID: "gmail-native", Mailbox: fmt.Sprintf("Folder%d", index), MailboxKind: "imap"})
			errorsOut <- err
		})
	}
	workers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal(err)
		}
	}
	id, _ := st.FindByEmailMessageID(ctx, "concurrent", "two@example.com")
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || len(message.Attachments) != 2 || len(message.Mailboxes) != 4 || message.ThreadID != "gmail-native" {
		t.Fatalf("concurrent duplicates: %+v, %v", message, err)
	}
	for index, header := range []string{"<same@example.com>", "<same@example.com> (comment)"} {
		raw := "Message-ID: " + header + "\r\n\r\nbody"
		parsed, err := Parse([]byte(raw))
		if err != nil || parsed.NormalizedMessageID != "same@example.com" {
			t.Fatalf("normalized identity: %+v %v", parsed, err)
		}
		mustImportRaw(t, target, "eml", "variant.eml", raw, EMLOptions{Source: "variants", ThreadID: fmt.Sprintf("native-%d", index)})
	}
	for index := range 2 {
		thread, err := st.GetThread(ctx, "variants", fmt.Sprintf("native-%d", index), 10)
		if err != nil || len(thread.Messages) != 1 {
			t.Fatalf("canonical variant lost: %+v %v", thread, err)
		}
	}
}
