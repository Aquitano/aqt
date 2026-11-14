package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/extract"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

var (
	digestA = content.Sum([]byte("a"))
	digestB = content.Sum([]byte("b"))
)

// seedMessage inserts one message with one attachment and returns the row id.
func seedMessage(t *testing.T, st *store.Store, externalID, body, filename string, digest content.Digest) int64 {
	t.Helper()
	return seedMessageSized(t, st, externalID, body, filename, digest, 1024)
}

// seedMessageSized is seedMessage with the attachment's size, which is what
// the default listing order is built on.
func seedMessageSized(t *testing.T, st *store.Store, externalID, body, filename string, digest content.Digest, size int64) int64 {
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
		SizeBytes: size, BLAKE3: digest,
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
		BLAKE3: digestA, Text: "invoice total 4200 EUR", Extractor: "pdf", Status: "ok",
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
	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: "better text", Status: "manual"}); err != nil {
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

	long := strings.Repeat("x", extract.MaxChars+1)
	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: long, Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	if bt, err = st.GetBlobText(ctx, digestA); err != nil || bt.Status != "truncated" || bt.Chars != extract.MaxChars {
		t.Fatalf("text over the cap: %s with %d characters, %v; want truncated at the cap", bt.Status, bt.Chars, err)
	}
}

// The whole point of keying on the digest: one extraction serves every message
// carrying that content, however many there are.
func TestStoredTextReachesEveryMessageCarryingIt(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "first mail", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "forwarded", "invoice.pdf", digestA)

	if err := st.PutBlobText(ctx, store.BlobText{
		BLAKE3: digestA, Text: "netherfield consulting invoice", Extractor: "pdf", Status: "ok",
	}); err != nil {
		t.Fatal(err)
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

// Storing text refreshes the messages carrying that content and no others: a
// stale row elsewhere stays as it was, where a whole-archive pass would fix it.
func TestStoredTextRefreshesOnlyTheMessagesCarryingIt(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	seedMessage(t, st, "m1", "first mail", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "forwarded", "invoice.pdf", digestA)
	other := seedMessage(t, st, "m3", "old mail", "scan.pdf", digestB)
	storetest.Exec(t, dsn, `update messages set attachment_text = 'stale' where id = $1`, other)

	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: "netherfield", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where attachment_text = 'netherfield'`); n != 2 {
		t.Fatalf("%d messages carry the new text, want the two with the content", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where id = $1 and attachment_text = 'stale'`, other); n != 1 {
		t.Fatal("a message without the content was rewritten")
	}
}

// Clearing text has to reach the index too, or a bad transcription stays
// searchable after being deleted.
func TestClearedTextLeavesTheIndex(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "body text", "scan.pdf", digestA)

	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: "kedleston", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBlobText(ctx, digestA); err != nil {
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

	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestB, Status: "needs_ocr"}); err != nil {
		t.Fatal(err)
	}
	pending, err = st.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{store.StatusPending}})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].BLAKE3 != digestA {
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

func TestExtractionStatsCountsDistinctContent(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	// Same content on two messages must count once: the question is how much
	// content is searchable, not how many rows point at it.
	seedMessage(t, st, "m1", "one", "invoice.pdf", digestA)
	seedMessage(t, st, "m2", "two", "invoice.pdf", digestA)
	seedMessage(t, st, "m3", "three", "scan.png", digestB)

	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: "abcdef", Status: "ok"}); err != nil {
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

	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Text: "hello", Status: "ok"}); err != nil {
		t.Fatal(err)
	}
	if _, atts, err = st.GetMessage(ctx, id); err != nil {
		t.Fatal(err)
	}
	if atts[0].TextStatus != "ok" || atts[0].TextChars != 5 {
		t.Fatalf("attachment = %+v", atts[0])
	}
}

func TestLateExtractionCannotOverwriteManualText(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	seedMessage(t, st, "m1", "see attached", "scan.pdf", digestA)
	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Status: "manual", Text: "corrected"}); err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"ok", "empty", "needs_ocr", "failed"} {
		if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Status: status, Text: "late worker"}); err != nil {
			t.Fatal(err)
		}
		got, err := st.GetBlobText(ctx, digestA)
		if err != nil || got.Status != "manual" || got.Text != "corrected" {
			t.Fatalf("manual text overwritten: %+v, %v", got, err)
		}
	}
	if err := st.PutBlobText(ctx, store.BlobText{BLAKE3: digestA, Status: "manual", Text: "second correction"}); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetBlobText(ctx, digestA)
	if err != nil || got.Text != "second correction" {
		t.Fatalf("manual replacement failed: %+v, %v", got, err)
	}
}
