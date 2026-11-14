package scan

import (
	"context"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// An attachment and a file on a disk with the same bytes are one content, so
// what either reader extracted is the other's too and neither reads it again.
func TestScanSharesContentsAndTextWithTheArchive(t *testing.T) {
	eachTransport(t, testScanSharesContentsAndTextWithTheArchive)
}

func testScanSharesContentsAndTextWithTheArchive(t *testing.T, catalogue newCatalogue) {
	ctx := context.Background()
	st, dsn := catalogue(t)
	archive := storetest.Open(t, dsn)
	contract, scanned := "Kaufvertrag Grundbuch Wohnung", "Mietvertrag Kaution Wohnung"
	id, err := archive.InsertMessage(ctx, store.Message{Source: "mail", ExternalID: "m1", SentAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for i, body := range []string{contract, scanned} {
		a := store.Attachment{MessageID: id, Position: i, Filename: "vertrag.txt", SizeBytes: int64(len(body)), BLAKE3: content.Sum([]byte(body))}
		if err := archive.InsertAttachment(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.PutBlobText(ctx, store.BlobText{BLAKE3: content.Sum([]byte(contract)), Text: "corrected by hand", Status: "manual"}); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	write(t, root, "Kauf.txt", contract)
	write(t, root, "Miete.txt", scanned)
	if res := scanAt(t, st, root, testVolume); res.Counts.Texts != 1 {
		t.Fatalf("read %d documents, want only the one bank has no text for", res.Counts.Texts)
	}

	var contents, shared int
	if err := storetest.Pool(t, dsn).QueryRow(ctx, `select (select count(*) from contents),
		(select count(*) from entries e join attachments a on a.content_id = e.content_id)`).Scan(&contents, &shared); err != nil {
		t.Fatal(err)
	}
	if contents != 2 || shared != 2 {
		t.Fatalf("%d contents rows and %d entries sharing one with an attachment, want 2 and 2", contents, shared)
	}
	manual, err := archive.GetBlobText(ctx, content.Sum([]byte(contract)))
	if err != nil || manual.Status != "manual" || manual.Text != "corrected by hand" {
		t.Fatalf("manual text after the scan: %+v, %v", manual, err)
	}
	read, err := archive.GetBlobText(ctx, content.Sum([]byte(scanned)))
	if err != nil || read.Status != "ok" || read.Text != scanned {
		t.Fatalf("text the scan read, as bank sees it: %+v, %v", read, err)
	}
	pending, err := archive.ListBlobs(ctx, store.ListBlobsOpts{Statuses: []string{store.StatusPending}})
	if err != nil || len(pending) != 0 {
		t.Fatalf("bank would extract again: %+v, %v", pending, err)
	}
}
