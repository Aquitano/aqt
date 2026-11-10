package server

import (
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

func TestExtractionTakesTextTheCatalogueAlreadyRead(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	// Bytes bank has no extractor for, which the catalogue read on a disk.
	bytes := []byte{0, 1, 2, 3, 'n', 'o', 't', ' ', 't', 'e', 'x', 't'}
	digest := blake3.Sum256(bytes)
	onDisk := view.Content{}
	onDisk.BLAKE3 = hex.EncodeToString(digest[:])
	s.UseCatalogue(modifiedFiles{content: onDisk, text: "the scanned contract, read once"})

	path := filepath.Join(t.TempDir(), "scan.bin")
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := c.UploadLibraryFiles(ctx, []string{path}, "", "", "")
	if err != nil || len(files) != 1 {
		t.Fatalf("upload: %+v, %v", files, err)
	}
	s.extraction.done.Wait()
	got, err := s.db.GetBlobText(ctx, files[0].SHA256)
	if err != nil || got.Status != "ok" || got.Text != "the scanned contract, read once" || got.Extractor != "attic: pdf" {
		t.Fatalf("blob text = %+v, %v", got, err)
	}
}

func TestRefsResolveAcrossTheArchiveAndTheCatalogue(t *testing.T) {
	ctx := context.Background()
	c, s := libraryClient(t)
	bytes := []byte("the plan, as a pdf")
	path := filepath.Join(t.TempDir(), "plan.pdf")
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := c.UploadLibraryFiles(ctx, []string{path}, "", "", "")
	if err != nil || len(files) != 1 {
		t.Fatalf("upload: %+v, %v", files, err)
	}
	s.extraction.done.Wait()
	s.digestBlobs(ctx)

	// The catalogue saw the same bytes on a disk.
	digest := blake3.Sum256(bytes)
	onDisk := view.Content{Occurrences: []view.Place{{Display: `E:\Docs\plan.pdf`}}}
	onDisk.BLAKE3, onDisk.Ref = hex.EncodeToString(digest[:]), hex.EncodeToString(digest[:8])
	s.UseCatalogue(modifiedFiles{content: onDisk})

	has := func(resolved catalog.Resolved, relation, ref, title string) bool {
		for _, link := range resolved.Links {
			if link.Relation == relation && link.Ref == ref && link.Title == title {
				return true
			}
		}
		return false
	}
	file, err := c.Resolve(ctx, files[0].ID)
	if err != nil || file.Kind != "file" || !has(file, "on_disk", "attic:"+onDisk.Ref, `E:\Docs\plan.pdf`) {
		t.Fatalf("library file: %+v, %v", file, err)
	}
	content, err := c.Resolve(ctx, "attic:"+onDisk.Ref)
	if err != nil || content.Kind != "content" || !has(content, "in_archive", files[0].ID, "plan.pdf") {
		t.Fatalf("content on a disk: %+v, %v", content, err)
	}
	if blob, err := c.Resolve(ctx, files[0].SHA256); err != nil || blob.Kind != "blob" || blob.Title != "plan.pdf" {
		t.Fatalf("blob by SHA-256: %+v, %v", blob, err)
	}

	sent := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)
	if _, err := s.db.InsertMessages(ctx, []store.Message{{Source: "whatsapp", ExternalID: "in", Sender: "alice", Body: "lunch?", SentAt: sent}}, store.InsertMessagesOpts{}); err != nil {
		t.Fatal(err)
	}
	listed, err := s.db.MessagesBetween(ctx, sent, sent.Add(time.Hour), 1)
	if err != nil || len(listed) != 1 {
		t.Fatalf("listing the message: %+v, %v", listed, err)
	}
	for _, cited := range []string{listed[0].Ref, "bank:" + listed[0].Ref} {
		if message, err := c.Resolve(ctx, cited); err != nil || message.Kind != "message" || message.Ref != "bank:"+listed[0].Ref || message.Title != "lunch?" {
			t.Fatalf("message cited as %s: %+v, %v", cited, message, err)
		}
	}
	for _, unknown := range []string{"bank:000000000000", "item_missing", "attic:0000000000000000", "nonsense"} {
		if _, err := c.Resolve(ctx, unknown); err == nil {
			t.Fatalf("%s resolved", unknown)
		}
	}
}
