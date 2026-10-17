package eml

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func TestMalformedMessageIDDoesNotBlockIngest(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, err := blob.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for index, messageID := range []string{"bad\x00@example.com", "bad\xff@example.com", "bad\x01@example.com"} {
		raw := []byte("Message-ID: " + messageID + "\r\n\r\nbody")
		opts := IngestOpts{Source: "malformed", ExternalID: fmt.Sprintf("mail%d", index)}
		for range 2 {
			result, err := Ingest(ctx, st, blobs, raw, opts)
			if err != nil || len(result.Warnings) == 0 {
				t.Fatalf("invalid ID wedged ingest: %+v %v", result, err)
			}
		}
		id, err := st.FindMessageID(ctx, opts.Source, opts.ExternalID)
		if err != nil {
			t.Fatal(err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil || message.Mail == nil || message.Mail.MessageID != "" || message.Body != "body" {
			t.Fatalf("malformed message not retained safely: %+v %v", message, err)
		}
	}
}

func TestMailRebuildPreservesCorrectedHeadersAndProvenance(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	blobs, err := blob.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := []byte("Message-ID: <child@example.com>\r\nReferences: <parent@example.com>\r\n\r\noriginal")
	corrected := []byte("Message-ID: <child@example.com>\r\n\r\ncorrected")
	var originalRef, correctedRef string
	for index, raw := range [][]byte{old, corrected} {
		name := []string{"z-old.eml", "a-corrected.eml"}[index]
		reference, err := archive.Write(root, "correction", name, raw)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: "correction", RawRef: reference}); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			originalRef = reference
		} else {
			correctedRef = filepath.ToSlash(reference)
		}
	}
	id, err := st.FindByEmailMessageID(ctx, "correction", "child@example.com")
	if err != nil {
		t.Fatal(err)
	}
	for _, apply := range []bool{false, true} {
		report, err := RebuildMail(ctx, st, root, "correction", apply)
		if err != nil || report.ThreadChanges != 0 || report.Messages != 2 {
			t.Fatalf("rebuild restored old headers: %+v %v", report, err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil || message.Mail == nil {
			t.Fatalf("missing provenance: %+v %v", message, err)
		}
		if len(message.Mail.References) != 0 || message.Mail.HasReplyLinks || message.Mail.RawRef != correctedRef || message.RawRef != originalRef || message.Body != "original" {
			t.Fatalf("incorrect provenance after rebuild: %+v, mail=%+v", message, message.Mail)
		}
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "1")
	if _, err := Ingest(ctx, st, blobs, old, IngestOpts{Source: "correction", RawRef: originalRef}); err != nil {
		t.Fatal(err)
	}
	limited, err := st.GetMessageDetail(ctx, id)
	if err != nil || limited.Mail == nil || !limited.Mail.Incomplete || len(limited.Mail.References) != 1 {
		t.Fatalf("pending correction missing from provenance: %+v %v", limited, err)
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "100")
	if _, err := RebuildMail(ctx, st, root, "correction", true); err != nil {
		t.Fatal(err)
	}
	recovered, err := st.GetMessageDetail(ctx, id)
	if err != nil || recovered.Mail == nil || recovered.Mail.Incomplete || !recovered.Mail.HasReplyLinks || recovered.Mail.RawRef != filepath.ToSlash(originalRef) {
		t.Fatalf("rebuild lost pending correction: %+v %v", recovered, err)
	}
}

func TestMailRebuildLargeEMLReadsOnlyHeaders(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	reference, err := archive.Write(root, "large", "message.eml", []byte("Message-ID: <large@example.com>\r\nReferences: <parent@example.com>\r\n\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(filepath.Join(root, reference), int64(maxMboxMessage)+1); err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertMessage(ctx, store.Message{Source: "large", ExternalID: "large@example.com", MessageID: "large@example.com", RawRef: reference, Body: "preserved"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, st, root, "large", true)
	if err != nil || report.Messages != 1 || report.Invalid != 0 {
		t.Fatalf("large EML was not rebuilt: %+v %v", report, err)
	}
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || message.Mail == nil || !message.Mail.HasReplyLinks || strings.Join(message.Mail.References, ",") != "parent@example.com" || message.Body != "preserved" {
		t.Fatalf("large EML metadata: %+v %v", message, err)
	}
}

func TestMailRebuildFindsGmailRawWithoutMessageID(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	root := t.TempDir()
	reference, err := archive.Write(root, "gmail", "18f00aa.eml", []byte("Subject: no id\r\nIn-Reply-To: <parent@example.com>\r\n\r\nbody"))
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertMessage(ctx, store.Message{Source: "gmail", ExternalID: "18f00aa", RawRef: reference})
	if err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, st, root, "gmail", true)
	if err != nil || report.Messages != 1 || report.Missing != 0 {
		t.Fatalf("gmail raw without Message-ID was not rebuilt: %+v %v", report, err)
	}
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || message.Mail == nil || !message.Mail.HasReplyLinks {
		t.Fatalf("gmail raw metadata: %+v %v", message, err)
	}
}

func TestMailReimportLeavesUnchangedThreadRowsAlone(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	blobs, err := blob.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ingest := func() {
		for _, raw := range []string{
			"Message-ID: <a@example.com>\r\n\r\nfirst",
			"Message-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\n\r\nsecond",
			"Message-ID: <c@example.com>\r\nReferences: <a@example.com> <b@example.com>\r\n\r\nthird",
		} {
			if _, err := Ingest(ctx, st, blobs, []byte(raw), IngestOpts{Source: "stable", MailContext: &MailImportContext{Version: 1, Kind: "imap", Mailbox: "INBOX", RelativePath: "input.eml"}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	versions := `select sum(xmin::text::bigint) from (select xmin from messages union all select xmin from mail_thread_nodes
		union all select xmin from mail_thread_aliases union all select xmin from mail_thread_conflicts
		union all select xmin from mail_details union all select xmin from mail_thread_edges
		union all select xmin from mailboxes) written`
	ingest()
	before := pgschematest.QueryInt(t, dsn, versions)
	ingest()
	if after := pgschematest.QueryInt(t, dsn, versions); after != before {
		t.Fatal("re-importing an unchanged thread rewrote its thread rows")
	}
}

func TestMailThreadArrivalOrdersAndConflicts(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, err := blob.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	raw := map[string][]byte{
		"a":         []byte("Message-ID: <a@example.com>\r\nSubject: Same subject\r\n\r\nroot"),
		"b":         []byte("Message-ID: <b@example.com>\r\nReferences: <a@example.com>\r\nSubject: Same subject\r\n\r\nreply"),
		"c":         []byte("Message-ID: <c@example.com>\r\nIn-Reply-To: <b@example.com>\r\nSubject: Same subject\r\n\r\nreply"),
		"unrelated": []byte("Message-ID: <unrelated@example.com>\r\nSubject: Same subject\r\n\r\nunrelated"),
	}
	var expected string
	for index, order := range [][]string{{"a", "b", "c"}, {"c", "b", "a"}, {"b", "a", "c"}} {
		source := fmt.Sprintf("order%d", index)
		var prior string
		for _, name := range order {
			if _, err := Ingest(ctx, st, blobs, raw[name], IngestOpts{Source: source}); err != nil {
				t.Fatal(err)
			}
			id, _ := st.FindByEmailMessageID(ctx, source, name+"@example.com")
			message, err := st.GetMessageDetail(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if prior == "" {
				prior = message.ThreadID
			}
		}
		thread, err := st.GetThread(ctx, source, prior, 10)
		if err != nil || len(thread.Messages) != 3 {
			t.Fatalf("late root alias: %+v, %v", thread, err)
		}
		if expected == "" {
			expected = thread.ThreadID
		} else if thread.ThreadID != expected {
			t.Fatalf("order-dependent thread: %s != %s", thread.ThreadID, expected)
		}
		if _, err := Ingest(ctx, st, blobs, raw["unrelated"], IngestOpts{Source: source}); err != nil {
			t.Fatal(err)
		}
		id, _ := st.FindByEmailMessageID(ctx, source, "unrelated@example.com")
		unrelated, _ := st.GetMessageDetail(ctx, id)
		if unrelated.ThreadID == thread.ThreadID {
			t.Fatal("subject-only merge")
		}
		original := thread.Messages[0].Ref
		if _, err := Ingest(ctx, st, blobs, raw["b"], IngestOpts{Source: source, ThreadID: "gmail-one"}); err != nil {
			t.Fatal(err)
		}
		anchored, err := st.GetThread(ctx, source, prior, 10)
		if err != nil || anchored.ThreadID != "gmail-one" || len(anchored.Messages) != 3 {
			t.Fatalf("provider enrichment: %+v, %v", anchored, err)
		}
		if anchored.Messages[0].Ref != original {
			t.Fatal("citation changed")
		}
		if _, err := Ingest(ctx, st, blobs, raw["c"], IngestOpts{Source: source, ThreadID: "gmail-two"}); err != nil {
			t.Fatal(err)
		}
		_, err = st.GetThread(ctx, source, prior, 10)
		var conflict *store.MailThreadConflictError
		if !errors.As(err, &conflict) || len(conflict.Choices) != 2 {
			t.Fatalf("expected typed split: %v", err)
		}
		page, err := st.MailConflictMessages(ctx, source, conflict.ConflictKey, 0, 1)
		if err != nil || len(page.Messages) != 1 || page.Messages[0].MessageID != "a@example.com" {
			t.Fatalf("unanchored page: %+v, %v", page, err)
		}
		if _, err := Ingest(ctx, st, blobs, raw["c"], IngestOpts{Source: source, ThreadID: "gmail-one"}); err != nil {
			t.Fatal(err)
		}
		healed, err := st.GetThread(ctx, source, prior, 10)
		if err != nil || healed.ThreadID != "gmail-one" || len(healed.Messages) != 3 {
			t.Fatalf("corrected conflict: %+v %v", healed, err)
		}
	}
}

func TestConcurrentMailObservationsAndNormalizedNodes(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	blobs, err := blob.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	errorsOut := make(chan error, 4)
	for index := range 4 {
		workers.Go(func() {
			_, err := Ingest(ctx, st, blobs, []byte(twoAttachmentMail), IngestOpts{Source: "concurrent", ThreadID: "gmail-native", MailContext: &MailImportContext{Version: 1, Kind: "imap", Mailbox: fmt.Sprintf("Folder%d", index), RelativePath: "input.eml"}})
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
		raw := []byte("Message-ID: " + header + "\r\n\r\nbody")
		parsed, err := Parse(raw)
		if err != nil || parsed.NormalizedMessageID != "same@example.com" {
			t.Fatalf("normalized identity: %+v %v", parsed, err)
		}
		if _, err := Ingest(ctx, st, blobs, raw, IngestOpts{Source: "variants", ThreadID: fmt.Sprintf("native-%d", index)}); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 2 {
		thread, err := st.GetThread(ctx, "variants", fmt.Sprintf("native-%d", index), 10)
		if err != nil || len(thread.Messages) != 1 {
			t.Fatalf("canonical variant lost: %+v %v", thread, err)
		}
	}
}

func TestMailRebuildReadOnlyRecoveryAndNewContext(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	root := t.TempDir()
	archiveDir := filepath.Join(root, "archive")
	blobs, err := blob.New(filepath.Join(root, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(root, "input.eml")
	if err := os.WriteFile(input, []byte(twoAttachmentMail), 0600); err != nil {
		t.Fatal(err)
	}
	observation := &MailImportContext{Version: 1, Kind: "export", Mailbox: "Work", RelativePath: "Work/input.eml"}
	if _, err := ImportEmlPath(ctx, st, blobs, archiveDir, "recover", input, observation); err != nil {
		t.Fatal(err)
	}
	id, _ := st.FindByEmailMessageID(ctx, "recover", "two@example.com")
	original, _ := st.GetMessageDetail(ctx, id)
	storetest.Exec(t, dsn, `truncate mailboxes,mailbox_messages,mail_details,mail_thread_edges,mail_thread_nodes,mail_thread_aliases,mail_thread_conflicts,mail_rebuild_progress`)
	storetest.Exec(t, dsn, `update messages set thread_id=''`)
	readOnly, err := store.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, readOnly, archiveDir, "recover", false)
	readOnly.Close()
	if err != nil || report.Messages != 1 || report.Apply {
		t.Fatalf("dry run: %+v %v", report, err)
	}
	mailboxes, _ := st.ListMailboxes(ctx, "recover")
	if len(mailboxes) != 0 {
		t.Fatal("dry run wrote membership")
	}
	report, err = RebuildMail(ctx, st, archiveDir, "recover", true)
	if err != nil || report.Messages != 1 {
		t.Fatalf("apply: %+v %v", report, err)
	}
	report, err = RebuildMail(ctx, st, archiveDir, "recover", true)
	if err != nil || report.Skipped != 1 {
		t.Fatalf("checkpoint: %+v %v", report, err)
	}
	observation.Mailbox = "Second"
	if _, err := archive.WriteMailContext(archiveDir, archive.MailContextRecord{Version: 1, Source: "recover", RawRef: original.RawRef, InputKind: "eml", Context: observation}); err != nil {
		t.Fatal(err)
	}
	report, err = RebuildMail(ctx, st, archiveDir, "recover", true)
	if err != nil || report.Messages != 1 || report.Skipped != 1 {
		t.Fatalf("new context skipped: %+v %v", report, err)
	}
	recovered, _ := st.GetMessageDetail(ctx, id)
	if recovered.Ref != original.Ref || recovered.Body != original.Body || recovered.RawRef != original.RawRef || len(recovered.Attachments) != 2 || len(recovered.Mailboxes) != 2 {
		t.Fatalf("recovery changed identity/content: %+v", recovered)
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "1")
	projection, err := st.ProjectMail(ctx, id, store.MailProjection{MessageID: "two@example.com", References: []string{"parent@example.com"}}, true, "")
	if err != nil || !projection.Incomplete {
		t.Fatalf("limit handling: %+v %v", projection, err)
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "10")
	projection, err = st.ProjectMail(ctx, id, store.MailProjection{MessageID: "two@example.com", References: []string{"parent@example.com"}}, true, "")
	if err != nil || projection.Incomplete {
		t.Fatalf("limit retry: %+v %v", projection, err)
	}
}

func TestSplitAliasesSurviveReimportAndLimitedCorrections(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	for index, native := range []bool{false, true} {
		source := fmt.Sprintf("split%d", index)
		first, err := st.InsertMessage(ctx, store.Message{Source: source, ExternalID: "a", MessageID: "a@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		second, err := st.InsertMessage(ctx, store.Message{Source: source, ExternalID: "b", MessageID: "b@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		parent := store.MailProjection{MessageID: "a@example.com", References: []string{"b@example.com"}}
		child := store.MailProjection{MessageID: "b@example.com"}
		initial, err := st.ProjectMail(ctx, first, parent, true, "original")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.ProjectMail(ctx, second, child, true, ""); err != nil {
			t.Fatal(err)
		}
		if native {
			parent.NativeThreadID = "native-a"
			child.NativeThreadID = "native-b"
			if _, err := st.ProjectMail(ctx, first, parent, true, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := st.ProjectMail(ctx, second, child, true, ""); err != nil {
				t.Fatal(err)
			}
		}
		parent.References = nil
		t.Setenv("BANK_MAIL_MAX_NODES", "1")
		limited, err := st.ProjectMail(ctx, first, parent, true, "")
		if err != nil || !limited.Incomplete {
			t.Fatalf("limited correction: %+v %v", limited, err)
		}
		t.Setenv("BANK_MAIL_MAX_NODES", "100")
		if _, err := st.ProjectMail(ctx, second, child, true, ""); err != nil {
			t.Fatal(err)
		}
		done, err := st.MailRebuildDone(ctx, source, "original", first)
		if err != nil || done {
			t.Fatalf("neighbor projection cleared a pending correction: %v %v", done, err)
		}
		for range 2 {
			result, err := st.ProjectMail(ctx, first, parent, true, "")
			if err != nil || result.Incomplete {
				t.Fatalf("retry: %+v %v", result, err)
			}
			_, err = st.GetThread(ctx, source, initial.ThreadID, 10)
			var conflict *store.MailThreadConflictError
			if !errors.As(err, &conflict) || len(conflict.Choices) != 2 {
				t.Fatalf("historical split was lost: %v", err)
			}
			for _, choice := range conflict.Choices {
				page, err := st.GetThreadPage(ctx, source, choice, store.ThreadOpts{Limit: 10, Current: true})
				if err != nil || len(page.Messages) != 1 {
					t.Fatalf("unreadable split choice %s: %+v %v", choice, page, err)
				}
			}
		}
	}
}

func TestMailRebuildPreviewIncludesEarlierProposals(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	root := t.TempDir()
	for index, name := range []string{"a", "b"} {
		header := ""
		if name == "a" {
			header = "References: <b@example.com>\r\n"
		}
		raw := []byte("Message-ID: <" + name + "@example.com>\r\n" + header + "\r\nmail")
		reference, err := archive.Write(root, "preview", name+".eml", raw)
		if err != nil {
			t.Fatal(err)
		}
		native := fmt.Sprintf("provider-%d", index)
		if _, err := st.InsertMessage(ctx, store.Message{Source: "preview", ExternalID: name, MessageID: name + "@example.com", ThreadID: native, RawRef: reference}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.WriteMailContext(root, archive.MailContextRecord{Version: 1, Source: "preview", RawRef: reference, InputKind: "eml", ExternalID: name, ThreadID: "stale-provider"}); err != nil {
			t.Fatal(err)
		}
	}
	readOnly, err := store.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := RebuildMail(ctx, readOnly, root, "preview", false)
	readOnly.Close()
	if err != nil || preview.Conflicts != 1 {
		t.Fatalf("dry preview missed conflict: %+v %v", preview, err)
	}
	applied, err := RebuildMail(ctx, st, root, "preview", true)
	if err != nil || applied.Conflicts != preview.Conflicts || applied.Messages != preview.Messages {
		t.Fatalf("apply differs: %+v %v", applied, err)
	}
	for index := range 2 {
		thread, err := st.GetThread(ctx, "preview", fmt.Sprintf("provider-%d", index), 10)
		if err != nil || len(thread.Messages) != 1 {
			t.Fatalf("historical context overwrote provider ID: %+v %v", thread, err)
		}
	}
}

func TestMailHistoryWorkIsBounded(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	t.Setenv("BANK_MAIL_MAX_NODES", "3")
	t.Setenv("BANK_MAIL_MAX_EDGES", "1")
	t.Setenv("BANK_MAIL_MAX_MESSAGES", "1")
	id, err := st.InsertMessage(ctx, store.Message{Source: "bounded", ExternalID: "mail"})
	if err != nil {
		t.Fatal(err)
	}
	incomplete := 0
	for index := range 16 {
		result, err := st.ProjectMail(ctx, id, store.MailProjection{MessageID: "m@example.com", References: []string{fmt.Sprintf("parent%d@example.com", index)}}, true, "")
		if err != nil {
			t.Fatal(err)
		}
		if result.Incomplete {
			incomplete++
		}
	}
	if incomplete == 0 {
		t.Fatal("historical resolution bypassed node budget")
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "100")
	result, err := st.ProjectMail(ctx, id, store.MailProjection{MessageID: "m@example.com", References: []string{"parent15@example.com"}}, true, "")
	if err != nil || result.Incomplete {
		t.Fatalf("historical limit retry: %+v %v", result, err)
	}
}
