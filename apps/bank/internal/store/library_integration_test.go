package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestImportReportRetainsPartialFailureAndNestedCounts(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	failure := errors.New("unreadable asset")
	_, err := store.RunImport(ctx, st, "chatgpt", "export.zip", func(ctx context.Context) (map[string]int, error) {
		_, err := store.RunImport(ctx, st, "nested", "part", func(ctx context.Context) (int, error) {
			_, err := st.InsertMessages(ctx, []store.Message{{Source: "chatgpt", ExternalID: "a", SentAt: time.Now()}, {Source: "chatgpt", ExternalID: "b", SentAt: time.Now()}}, store.InsertMessagesOpts{})
			return 0, err
		})
		if err != nil {
			return nil, err
		}
		store.ImportIssue(ctx, "Missing asset file-x")
		return map[string]int{"missing_media": 1}, failure
	})
	if !errors.Is(err, failure) {
		t.Fatal(err)
	}
	reports, err := st.ImportReports(ctx, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].Status != "failed" || reports[0].FinishedAt == nil || reports[0].Error != failure.Error() {
		t.Fatalf("reports: %+v", reports)
	}
	var result struct {
		Inserted int      `json:"inserted"`
		Missing  int      `json:"missing_media"`
		Issues   []string `json:"issues"`
	}
	if err := json.Unmarshal(reports[0].Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Inserted != 2 || result.Missing != 1 || len(result.Issues) != 1 {
		t.Fatalf("result: %+v", result)
	}
}

func TestAttachmentLibraryFiltersAndFindsEveryOccurrence(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	at := time.Date(2025, 1, 2, 12, 0, 0, 0, time.UTC)
	ids, err := st.InsertMessages(ctx, []store.Message{
		{Source: "mail", ExternalID: "a", Sender: "alice@example.com", SentAt: at},
		{Source: "mail", ExternalID: "b", Sender: "bob@example.com", Recipients: []string{"alice@example.com"}, SentAt: at.AddDate(0, 0, 1)},
		{Source: "mail", ExternalID: "c", Sender: "carol@example.com", SentAt: at.AddDate(0, 0, 2)},
	}, store.InsertMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	sum := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	for i, id := range ids {
		name := "renamed.pdf"
		if i == 0 {
			name = "Invoice_100%.PDF"
		}
		if err := st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: name, MimeType: "application/pdf", SizeBytes: 20, SHA256: sum}); err != nil {
			t.Fatal(err)
		}
	}
	// Two copies on one message still count as one occurrence.
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: ids[0], Filename: "copy.pdf", SHA256: sum}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateContact(ctx, "alice", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddAlias(ctx, "alice", "", "alice@example.com"); err != nil {
		t.Fatal(err)
	}
	files, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Filename: "100%", FileType: "pdf", Person: "alice", Since: at, Until: at.AddDate(0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Messages != 3 || files[0].Filename != "Invoice_100%.PDF" {
		t.Fatalf("files: %+v", files)
	}
	page, err := st.AttachmentMessages(ctx, sum, 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	next, err := st.AttachmentMessages(ctx, sum, 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || len(next) != 1 || next[0].ID != ids[0] {
		t.Fatalf("pages: %+v %+v", page, next)
	}
	absent, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{FileType: "image"})
	if err != nil || len(absent) != 0 {
		t.Fatalf("image filter: %+v %v", absent, err)
	}
}

func TestAttachmentLibraryMatchesEachFilesOwnText(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	id, err := st.InsertMessage(ctx, store.Message{Source: "mail", ExternalID: "files", SentAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for i, contents := range []string{strings.Repeat("preface ", 60) + "Payment 100% due tomorrow", "Unrelated document", "payment 100% without valid extraction"} {
		sum := strings.Repeat(string(rune('a'+i)), 64)
		if err := st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: fmt.Sprintf("file%d.pdf", i), MimeType: "application/pdf", SHA256: sum}); err != nil {
			t.Fatal(err)
		}
		status := "ok"
		if i == 2 {
			status = "failed"
		}
		if err := st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: contents, Status: status}); err != nil {
			t.Fatal(err)
		}
	}
	for _, status := range []string{"ok", "manual"} {
		sum := strings.Repeat("a", 64)
		if status == "manual" {
			if err := st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "Payment 100% due tomorrow", Status: status}); err != nil {
				t.Fatal(err)
			}
		}
		files, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Text: "PAYMENT 100%", FileType: "pdf"})
		if err != nil {
			t.Fatal(err)
		}
		if len(files) != 1 || files[0].SHA256 != sum || !strings.Contains(files[0].Snippet, "Payment 100%") || len(files[0].Snippet) > 240 {
			t.Fatalf("%s contents filter: %+v", status, files)
		}
	}
	files, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Text: "payment 100%", Filename: "file1"})
	if err != nil || len(files) != 0 {
		t.Fatalf("combined filters: %+v %v", files, err)
	}
}

func TestBranchMissingParentAndCycleAreBounded(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	ids, err := st.InsertMessages(ctx, []store.Message{
		{Source: "chatgpt", ExternalID: "a", ThreadID: "chat", ParentExternalID: "b", SentAt: time.Now()},
		{Source: "chatgpt", ExternalID: "b", ThreadID: "chat", ParentExternalID: "a", SentAt: time.Now()},
		{Source: "chatgpt", ExternalID: "c", ThreadID: "chat", ParentExternalID: "missing", SentAt: time.Now()},
	}, store.InsertMessagesOpts{})
	if err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		branch, err := st.MessageBranch(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		want := 2
		if i == 2 {
			want = 1
		}
		if !branch.Incomplete || len(branch.Messages) != want {
			t.Fatalf("branch: %+v", branch)
		}
	}
}

func TestReimportWithoutReplyMetadataKeepsKnownBranch(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	m := store.Message{Source: "chatgpt", ExternalID: "answer", ThreadID: "chat", ParentExternalID: "question", BranchID: "branch", AlternativeIndex: 2, SentAt: time.Now()}
	id, err := st.InsertMessage(ctx, m)
	if err != nil {
		t.Fatal(err)
	}
	m.ParentExternalID = ""
	m.BranchID = ""
	m.AlternativeIndex = 0
	if _, err := st.InsertMessageRethreading(ctx, m); err != nil {
		t.Fatal(err)
	}
	got, _, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.ParentExternalID != "question" || got.BranchID != "branch" || got.AlternativeIndex != 2 {
		t.Fatalf("lost metadata: %+v", got)
	}
}
