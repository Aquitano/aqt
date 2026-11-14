package eml

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/db"
	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
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

func TestMailRebuildPreservesCorrectedHeadersAndProvenance(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	old := "Message-ID: <child@example.com>\r\nReferences: <parent@example.com>\r\n\r\noriginal"
	corrected := "Message-ID: <child@example.com>\r\n\r\ncorrected"
	options := EMLOptions{Source: "correction"}
	original := mustImportRaw(t, target, "eml", "old.eml", old, options)
	correction := mustImportRaw(t, target, "eml", "corrected.eml", corrected, options)
	id, err := st.FindByEmailMessageID(ctx, "correction", "child@example.com")
	if err != nil {
		t.Fatal(err)
	}
	for _, apply := range []bool{false, true} {
		report, err := RebuildMail(ctx, st, target.Blobs, "correction", apply)
		if err != nil || report.ThreadChanges != 0 || report.Messages != 2 {
			t.Fatalf("rebuild restored old headers: %+v %v", report, err)
		}
		message, err := st.GetMessageDetail(ctx, id)
		if err != nil || message.Mail == nil {
			t.Fatalf("missing provenance: %+v %v", message, err)
		}
		if len(message.Mail.References) != 0 || message.Mail.HasReplyLinks || message.Mail.RawInput != correction.ID || message.RawInput != original.ID || message.Body != "original" {
			t.Fatalf("incorrect provenance after rebuild: %+v, mail=%+v", message, message.Mail)
		}
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "1")
	again := mustImportRaw(t, target, "eml", "old-again.eml", old, options)
	limited, err := st.GetMessageDetail(ctx, id)
	if err != nil || limited.Mail == nil || !limited.Mail.Incomplete || len(limited.Mail.References) != 1 {
		t.Fatalf("pending correction missing from provenance: %+v %v", limited, err)
	}
	t.Setenv("BANK_MAIL_MAX_NODES", "100")
	if _, err := RebuildMail(ctx, st, target.Blobs, "correction", true); err != nil {
		t.Fatal(err)
	}
	recovered, err := st.GetMessageDetail(ctx, id)
	if err != nil || recovered.Mail == nil || recovered.Mail.Incomplete || !recovered.Mail.HasReplyLinks || recovered.Mail.RawInput != again.ID {
		t.Fatalf("rebuild lost pending correction: %+v %v", recovered, err)
	}
}

func TestMailRebuildLargeEMLReadsOnlyHeaders(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	path := filepath.Join(t.TempDir(), "message.eml")
	if err := os.WriteFile(path, []byte("Message-ID: <large@example.com>\r\nReferences: <parent@example.com>\r\n\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, int64(maxMboxMessage)+1); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rawID := storeRaw(t, target, "eml", "message.eml", f, `{"source":"large"}`)
	id, err := st.InsertMessage(ctx, store.Message{Source: "large", ExternalID: "large@example.com", MessageID: "large@example.com", RawInput: rawID, Body: "preserved"})
	if err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, st, target.Blobs, "large", true)
	if err != nil || report.Messages != 1 || report.Invalid != 0 {
		t.Fatalf("large EML was not rebuilt: %+v %v", report, err)
	}
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || message.Mail == nil || !message.Mail.HasReplyLinks || strings.Join(message.Mail.References, ",") != "parent@example.com" || message.Body != "preserved" {
		t.Fatalf("large EML metadata: %+v %v", message, err)
	}
}

// Mail without a Message-ID is keyed by the digest of its raw input, which
// rebuild takes from the stored row instead of reading the bytes for it: a
// body replaced after the import changes nothing rebuild resolves.
func TestMailWithoutMessageIDKeepsItsKeyInRebuild(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	const headers = "Subject: no id\r\nReferences: <parent@example.com>\r\n\r\n"
	raw := mustImportRaw(t, target, "eml", "anonymous.eml", headers+"imported body", EMLOptions{Source: "anonymous"})
	id, err := st.FindMessageID(ctx, "anonymous", raw.BLAKE3.String())
	if err != nil {
		t.Fatalf("import did not key the message by its input's digest: %v", err)
	}
	stored := target.Blobs.Path(raw.BLAKE3)
	if err := os.Remove(stored); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stored, []byte(headers+"another body"), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, st, target.Blobs, "anonymous", true)
	if err != nil || report.Messages != 1 || report.Missing != 0 {
		t.Fatalf("rebuild did not find the message by its input's digest: %+v %v", report, err)
	}
	message, err := st.GetMessageDetail(ctx, id)
	if err != nil || message.Mail == nil || !message.Mail.HasReplyLinks {
		t.Fatalf("rebuilt metadata: %+v %v", message, err)
	}
}

// storeRaw records an input the way the importer stores it, without parsing
// it, for a rebuild to read.
func storeRaw(t *testing.T, target importer.Target, kind, name string, r io.Reader, options string) int64 {
	t.Helper()
	ctx := context.Background()
	digest, size, err := target.Blobs.Put(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	id, err := target.Store.AddRawInput(ctx, kind, name, digest, size, json.RawMessage(options))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestMailReimportLeavesUnchangedThreadRowsAlone(t *testing.T) {
	st, dsn := storetest.NewNamed(t)
	target := mailTarget(t, st)
	importAll := func() {
		for index, raw := range []string{
			"Message-ID: <a@example.com>\r\n\r\nfirst",
			"Message-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\n\r\nsecond",
			"Message-ID: <c@example.com>\r\nReferences: <a@example.com> <b@example.com>\r\n\r\nthird",
		} {
			mustImportRaw(t, target, "eml", fmt.Sprintf("input%d.eml", index), raw, EMLOptions{Source: "stable", Mailbox: "INBOX", MailboxKind: "imap"})
		}
	}
	versions := `select sum(xmin::text::bigint) from (select xmin from messages union all select xmin from mail_thread_nodes
		union all select xmin from mail_thread_aliases union all select xmin from mail_thread_conflicts
		union all select xmin from mail_details union all select xmin from mail_thread_edges
		union all select xmin from mailboxes) written`
	importAll()
	before := pgschematest.QueryInt(t, dsn, versions)
	importAll()
	if after := pgschematest.QueryInt(t, dsn, versions); after != before {
		t.Fatal("re-importing an unchanged thread rewrote its thread rows")
	}
}

func TestMailThreadArrivalOrdersAndConflicts(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	target := mailTarget(t, st)
	raw := map[string]string{
		"a":         "Message-ID: <a@example.com>\r\nSubject: Same subject\r\n\r\nroot",
		"b":         "Message-ID: <b@example.com>\r\nReferences: <a@example.com>\r\nSubject: Same subject\r\n\r\nreply",
		"c":         "Message-ID: <c@example.com>\r\nIn-Reply-To: <b@example.com>\r\nSubject: Same subject\r\n\r\nreply",
		"unrelated": "Message-ID: <unrelated@example.com>\r\nSubject: Same subject\r\n\r\nunrelated",
	}
	importMail := func(name string, options EMLOptions) {
		t.Helper()
		mustImportRaw(t, target, "eml", name+".eml", raw[name], options)
	}
	var expected string
	for index, order := range [][]string{{"a", "b", "c"}, {"c", "b", "a"}, {"b", "a", "c"}} {
		source := fmt.Sprintf("order%d", index)
		var prior string
		for _, name := range order {
			importMail(name, EMLOptions{Source: source})
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
		importMail("unrelated", EMLOptions{Source: source})
		id, _ := st.FindByEmailMessageID(ctx, source, "unrelated@example.com")
		unrelated, _ := st.GetMessageDetail(ctx, id)
		if unrelated.ThreadID == thread.ThreadID {
			t.Fatal("subject-only merge")
		}
		original := thread.Messages[0].Ref
		importMail("b", EMLOptions{Source: source, ThreadID: "gmail-one"})
		anchored, err := st.GetThread(ctx, source, prior, 10)
		if err != nil || anchored.ThreadID != "gmail-one" || len(anchored.Messages) != 3 {
			t.Fatalf("provider enrichment: %+v, %v", anchored, err)
		}
		if anchored.Messages[0].Ref != original {
			t.Fatal("citation changed")
		}
		importMail("c", EMLOptions{Source: source, ThreadID: "gmail-two"})
		_, err = st.GetThread(ctx, source, prior, 10)
		var conflict *store.MailThreadConflictError
		if !errors.As(err, &conflict) || len(conflict.Choices) != 2 {
			t.Fatalf("expected typed split: %v", err)
		}
		page, err := st.MailConflictMessages(ctx, source, conflict.ConflictKey, ref.Message{}, 1)
		if err != nil || len(page.Messages) != 1 || page.Messages[0].MessageID != "a@example.com" {
			t.Fatalf("unanchored page: %+v, %v", page, err)
		}
		importMail("c", EMLOptions{Source: source, ThreadID: "gmail-one"})
		healed, err := st.GetThread(ctx, source, prior, 10)
		if err != nil || healed.ThreadID != "gmail-one" || len(healed.Messages) != 3 {
			t.Fatalf("corrected conflict: %+v %v", healed, err)
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

func TestMailRebuildReadOnlyRecoveryAndNewMailbox(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	target := mailTarget(t, st)
	first := mustImportRaw(t, target, "eml", "input.eml", twoAttachmentMail, EMLOptions{Source: "recover", Mailbox: "Work"})
	id, _ := st.FindByEmailMessageID(ctx, "recover", "two@example.com")
	original, _ := st.GetMessageDetail(ctx, id)
	storetest.Exec(t, dsn, `truncate mailboxes,mailbox_messages,mail_details,mail_thread_edges,mail_thread_nodes,mail_thread_aliases,mail_thread_conflicts,mail_rebuild_progress`)
	storetest.Exec(t, dsn, `update messages set thread_id=''`)
	readOnly, err := db.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	report, err := RebuildMail(ctx, store.New(readOnly), target.Blobs, "recover", false)
	readOnly.Close()
	if err != nil || report.Messages != 1 || report.Apply {
		t.Fatalf("dry run: %+v %v", report, err)
	}
	mailboxes, _ := st.ListMailboxes(ctx, "recover")
	if len(mailboxes) != 0 {
		t.Fatal("dry run wrote membership")
	}
	report, err = RebuildMail(ctx, st, target.Blobs, "recover", true)
	if err != nil || report.Messages != 1 {
		t.Fatalf("apply: %+v %v", report, err)
	}
	report, err = RebuildMail(ctx, st, target.Blobs, "recover", true)
	if err != nil || report.Skipped != 1 {
		t.Fatalf("checkpoint: %+v %v", report, err)
	}
	mustImportRaw(t, target, "eml", "input.eml", twoAttachmentMail, EMLOptions{Source: "recover", Mailbox: "Second"})
	report, err = RebuildMail(ctx, st, target.Blobs, "recover", true)
	if err != nil || report.Messages != 1 || report.Skipped != 1 {
		t.Fatalf("new mailbox skipped: %+v %v", report, err)
	}
	recovered, _ := st.GetMessageDetail(ctx, id)
	if recovered.Ref != original.Ref || recovered.Body != original.Body || recovered.RawInput != first.ID || len(recovered.Attachments) != 2 || len(recovered.Mailboxes) != 2 {
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
	target := mailTarget(t, st)
	for index, name := range []string{"a", "b"} {
		header := ""
		if name == "a" {
			header = "References: <b@example.com>\r\n"
		}
		raw := "Message-ID: <" + name + "@example.com>\r\n" + header + "\r\nmail"
		rawID := storeRaw(t, target, "eml", name+".eml", strings.NewReader(raw), `{"source":"preview","external_id":"`+name+`","thread_id":"stale-provider"}`)
		native := fmt.Sprintf("provider-%d", index)
		if _, err := st.InsertMessage(ctx, store.Message{Source: "preview", ExternalID: name, MessageID: name + "@example.com", ThreadID: native, RawInput: rawID}); err != nil {
			t.Fatal(err)
		}
	}
	readOnly, err := db.OpenReadOnly(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := RebuildMail(ctx, store.New(readOnly), target.Blobs, "preview", false)
	readOnly.Close()
	if err != nil || preview.Conflicts != 1 {
		t.Fatalf("dry preview missed conflict: %+v %v", preview, err)
	}
	applied, err := RebuildMail(ctx, st, target.Blobs, "preview", true)
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
