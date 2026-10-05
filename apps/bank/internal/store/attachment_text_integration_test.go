package store_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

const (
	digestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	digestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// seedMessage inserts one message with one attachment and returns the row id.
func seedMessage(t *testing.T, st *store.Store, externalID, body, filename, digest string) int64 {
	t.Helper()
	return seedMessageSized(t, st, externalID, body, filename, digest, 1024)
}

// seedMessageSized is seedMessage with the attachment's size, which is what
// the default listing order is built on.
func seedMessageSized(t *testing.T, st *store.Store, externalID, body, filename, digest string, size int64) int64 {
	t.Helper()
	ctx := context.Background()
	id, err := st.InsertMessage(ctx, store.Message{
		Source: "proton", ExternalID: externalID, Sender: "alice@example.com",
		Subject: "here it is", Body: body, SentAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAttachment(ctx, store.Attachment{
		MessageID: id, Filename: filename, MimeType: "application/pdf",
		SizeBytes: size, SHA256: digest,
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestBlobTextRoundTrip(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "see attached", "invoice.pdf", digestA)

	if _, err := st.GetBlobText(ctx, digestA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound before extraction", err)
	}
	if err := st.PutBlobText(ctx, store.BlobText{
		SHA256: digestA, Text: "invoice total 4200 EUR", Extractor: "pdf", Status: "ok",
	}); err != nil {
		t.Fatal(err)
	}
	bt, err := st.GetBlobText(ctx, digestA)
	if err != nil {
		t.Fatal(err)
	}
	if bt.Text != "invoice total 4200 EUR" || bt.Status != "ok" || bt.Chars != 22 {
		t.Fatalf("got %+v", bt)
	}

	// Re-extraction replaces rather than duplicates.
	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestA, Text: "better text", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	if bt, _ = st.GetBlobText(ctx, digestA); bt.Status != "manual" || bt.Text != "better text" {
		t.Fatalf("got %+v", bt)
	}

	if err := st.DeleteBlobText(ctx, digestA); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBlobText(ctx, digestA); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound on a second delete", err)
	}
}

func TestListBlobsNewestFirstAcrossLibraryAndMail(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	id := seedMessage(t, st, "old", "Old message", "old.pdf", digestA)
	storetest.Exec(t, schema, `update messages set ingested_at='1999-01-01'`)
	storetest.Exec(t, schema, `update attachments set ingested_at=null`)
	files := []library.File{}
	for i := range 201 {
		files = append(files, library.File{Identity: library.Identity{Source: "files", Account: "owner", ExternalID: fmt.Sprint(i)}, SHA256: fmt.Sprintf("%064x", i+1), Filename: fmt.Sprintf("old-%d.txt", i), MimeType: "text/plain", SizeBytes: 1})
	}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: files}); err != nil {
		t.Fatal(err)
	}
	storetest.Exec(t, schema, `update library_files set ingested_at='2000-01-01'`)
	if err := st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "fresh.pdf", MimeType: "application/pdf", SizeBytes: 1, SHA256: digestB}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{store.StatusPending}, Limit: 200, NewestFirst: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 200 || rows[0].SHA256 != digestB {
		t.Fatalf("new attachment to an old message was displaced: %+v", rows)
	}
	file := library.File{Identity: library.Identity{Source: "files", Account: "owner", ExternalID: "fresh"}, SHA256: strings.Repeat("c", 64), Filename: "fresh.txt", MimeType: "text/plain", SizeBytes: 1}
	if _, err := st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: []library.File{file}}); err != nil {
		t.Fatal(err)
	}
	rows, err = st.ListBlobs(ctx, store.ListBlobsOpts{NewestFirst: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].SHA256 != file.SHA256 {
		t.Fatalf("new library file was displaced: %+v", rows)
	}
}

// The whole point of keying on the digest: one extraction serves every message
// carrying that content, however many there are.
func TestRefreshAttachmentTextSharesOneExtractionAcrossMessages(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "first mail", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "forwarded", "invoice.pdf", digestA)

	if err := st.PutBlobText(ctx, store.BlobText{
		SHA256: digestA, Text: "netherfield consulting invoice", Extractor: "pdf", Status: "ok",
	}); err != nil {
		t.Fatal(err)
	}
	n, err := st.RefreshAttachmentText(ctx, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("reindexed %d messages, want 2", n)
	}

	// Idempotent: a second refresh with nothing changed must touch no rows,
	// or every import would rewrite the whole table.
	if n, err = st.RefreshAttachmentText(ctx, time.Time{}); err != nil || n != 0 {
		t.Fatalf("second refresh: %d rows, %v; want 0, nil", n, err)
	}

	msgs, err := st.Search(ctx, "netherfield", store.SearchOpts{Fuzzy: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("found %d messages by a word only in the attachment, want 2", len(msgs))
	}
	if msgs[0].AttachmentSnippet == "" {
		t.Errorf("no attachment snippet: a hit inside a PDF should say what matched")
	}
	if !strings.Contains(strings.ToLower(msgs[0].AttachmentSnippet), "netherfield") {
		t.Errorf("attachment snippet = %q", msgs[0].AttachmentSnippet)
	}
}

func TestRefreshAttachmentTextSinceSkipsOlderMessages(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	older := seedMessage(t, st, "m1", "first mail", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "forwarded", "invoice.pdf", digestA)
	storetest.Exec(t, schema, `update attachments set ingested_at = now() - interval '1 hour' where message_id = $1`, older)
	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestA, Text: "netherfield", Extractor: "pdf", Status: "ok"}); err != nil {
		t.Fatal(err)
	}

	if n, err := st.RefreshAttachmentText(ctx, time.Now().Add(-time.Minute)); err != nil || n != 1 {
		t.Fatalf("scoped refresh: %d rows, %v; want only the recent message", n, err)
	}
	if n, err := st.RefreshAttachmentText(ctx, time.Time{}); err != nil || n != 1 {
		t.Fatalf("full refresh: %d rows, %v; want the older message left behind", n, err)
	}
}

// Clearing text has to reach the index too, or a bad transcription stays
// searchable after being deleted.
func TestRefreshAttachmentTextRemovesClearedText(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "body text", "scan.pdf", digestA)

	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestA, Text: "kedleston", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RefreshAttachmentText(ctx, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBlobText(ctx, digestA); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RefreshAttachmentText(ctx, time.Time{}); err != nil {
		t.Fatal(err)
	}
	msgs, err := st.Search(ctx, "kedleston", store.SearchOpts{Fuzzy: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("found %d messages by cleared attachment text, want 0", len(msgs))
	}
}

func TestListBlobsByStatus(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "one", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "two", "scan.png", digestB)

	pending, err := st.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{store.StatusPending}})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending = %d, want both blobs before anything ran", len(pending))
	}

	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestB, Status: "needs_ocr"}); err != nil {
		t.Fatal(err)
	}
	pending, err = st.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{store.StatusPending}})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].SHA256 != digestA {
		t.Fatalf("pending = %+v, want only the untouched blob", pending)
	}

	ocr, err := st.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{"needs_ocr"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(ocr) != 1 || ocr[0].Filename != "scan.png" {
		t.Fatalf("needs_ocr = %+v", ocr)
	}

	if none, err := st.ListBlobs(ctx, store.ListBlobsOpts{Source: "whatsapp"}); err != nil || len(none) != 0 {
		t.Fatalf("source filter: %d blobs, %v", len(none), err)
	}
}

// The pass that runs after an import is bounded, so what just landed has to be
// at the front of the batch rather than behind a backlog of bigger files.
func TestListBlobsNewestFirst(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "old", "backlog.pdf", digestA)
	seedMessageSized(t, st, "m2", "new", "receipt.pdf", digestB, 16)

	newest, err := st.ListBlobs(ctx, store.ListBlobsOpts{NewestFirst: true, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(newest) != 1 || newest[0].SHA256 != digestB {
		t.Fatalf("newest first = %+v, want the just-stored attachment", newest)
	}

	// The default stays largest first: a bounded manual run and the worker
	// should spend their budget on the documents with the most text in them.
	largest, err := st.ListBlobs(ctx, store.ListBlobsOpts{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(largest) != 1 || largest[0].SHA256 != digestA {
		t.Fatalf("default order = %+v, want the largest blob", largest)
	}
}

func TestExtractionStatsCountsDistinctContent(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	// Same content on two messages must count once: the question is how much
	// content is searchable, not how many rows point at it.
	seedMessage(t, st, "m1", "one", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "two", "invoice.pdf", digestA)
	seedMessage(t, st, "m3", "three", "scan.png", digestB)

	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestA, Text: "abcdef", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	stats, err := st.ExtractionStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]store.ExtractionStat{}
	for _, s := range stats {
		got[s.Status] = s
	}
	if got["ok"].Blobs != 1 || got["ok"].Chars != 6 {
		t.Errorf("ok = %+v, want 1 blob and 6 characters", got["ok"])
	}
	if got[store.StatusPending].Blobs != 1 {
		t.Errorf("pending = %+v, want the one blob nothing has read", got[store.StatusPending])
	}
}

func TestGetMessageReportsAttachmentTextStatus(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	id := seedMessage(t, st, "m1", "body", "invoice.pdf", digestA)

	_, atts, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(atts) != 1 || atts[0].TextStatus != store.StatusPending {
		t.Fatalf("attachments = %+v, want one pending", atts)
	}

	if err := st.PutBlobText(ctx, store.BlobText{SHA256: digestA, Text: "hello", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	if _, atts, err = st.GetMessage(ctx, id); err != nil {
		t.Fatal(err)
	}
	if atts[0].TextStatus != "ok" || atts[0].TextChars != 5 {
		t.Fatalf("attachment = %+v", atts[0])
	}
}

func TestValidSHA256(t *testing.T) {
	if err := store.ValidSHA256(digestA); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("z", 64), digestA + "0"} {
		if err := store.ValidSHA256(bad); err == nil {
			t.Errorf("ValidSHA256(%q) accepted", bad)
		}
	}
}
