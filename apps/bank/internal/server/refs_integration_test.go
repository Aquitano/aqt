package server

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestRefsResolveAcrossTheArchiveAndTheCatalogue(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	dir := t.TempDir()
	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	s := New(st, attic.New(storetest.OpenCatalogue(t, dsn)), blobs, dir, filepath.Join(dir, "archive"))
	t.Cleanup(s.extraction.done.Wait)
	token, err := Tokens(dir).New("refs-test", tokens.Scope{})
	if err != nil {
		t.Fatal(err)
	}
	host := httptest.NewServer(s.Handler())
	t.Cleanup(host.Close)
	c := client.New(host.URL, token)
	bytes := []byte("the plan, as a pdf")
	path := filepath.Join(t.TempDir(), "plan.pdf")
	if err = os.WriteFile(path, bytes, 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := c.UploadLibraryFiles(ctx, []string{path}, "", "", "")
	if err != nil || len(files) != 1 {
		t.Fatalf("upload: %+v, %v", files, err)
	}
	s.extraction.done.Wait()
	digest := content.Sum(bytes)
	sent := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)
	id, err := s.db.InsertMessage(ctx, store.Message{Source: "whatsapp", ExternalID: "in", Sender: "alice", Body: "lunch?", SentAt: sent})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.db.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "plan-v2.pdf", SizeBytes: int64(len(bytes)), BLAKE3: digest}); err != nil {
		t.Fatal(err)
	}

	// A scan of a disk that holds the same bytes lands on the same contents row.
	storetest.Exec(t, dsn, `
		insert into volumes (id, label, fs_type, serial, stable_ids) values ('00000000-0000-0000-0000-000000000001', 'Docs', 'NTFS', 'AB', true);
		insert into scans (id, volume_id, root, status) overriding system value values (1, '00000000-0000-0000-0000-000000000001', '', 'complete');
		insert into entries (volume_id, kind, name, raw_name, path, content_id, hash_state, first_scan, updated_scan)
		select '00000000-0000-0000-0000-000000000001', 'file', 'plan.pdf', 'plan.pdf'::bytea, '/plan.pdf', c.id, 'done', 1, 1
		from contents c where c.blake3 = decode('`+digest.String()+`', 'hex')`)
	ref, onDisk := digest.String()[:16], "Docs:"+string(filepath.Separator)+"plan.pdf"

	has := func(resolved catalog.Resolved, relation, ref, title string) bool {
		for _, link := range resolved.Links {
			if link.Relation == relation && link.Ref == ref && link.Title == title {
				return true
			}
		}
		return false
	}
	file, err := c.Resolve(ctx, files[0].ID)
	if err != nil || file.Kind != "file" || !has(file, "on_disk", "attic:"+ref, onDisk) {
		t.Fatalf("library file: %+v, %v", file, err)
	}
	for _, cited := range []string{"attic:" + ref, digest.String()} {
		resolved, err := c.Resolve(ctx, cited)
		if err != nil || resolved.Kind != "content" || resolved.Ref != "attic:"+ref || resolved.Title != "plan.pdf" ||
			!has(resolved, "in_archive", files[0].ID, "plan.pdf") || !has(resolved, "in_archive", digest.String(), "plan-v2.pdf") ||
			!has(resolved, "on_disk", "attic:"+ref, onDisk) {
			t.Fatalf("content cited as %s: %+v, %v", cited, resolved, err)
		}
	}

	listed, err := s.db.MessagesBetween(ctx, sent, sent.Add(time.Hour), 1)
	if err != nil || len(listed) != 1 {
		t.Fatalf("listing the message: %+v, %v", listed, err)
	}
	for _, cited := range []string{listed[0].Ref, "bank:" + listed[0].Ref} {
		message, err := c.Resolve(ctx, cited)
		if err != nil || message.Kind != "message" || message.Ref != "bank:"+listed[0].Ref || message.Title != "lunch?" ||
			!has(message, "attachment", digest.String(), "plan-v2.pdf") || !has(message, "on_disk", "attic:"+ref, onDisk) {
			t.Fatalf("message cited as %s: %+v, %v", cited, message, err)
		}
	}
	for _, unknown := range []string{"bank:000000000000", "item_missing", "attic:0000000000000000", "nonsense"} {
		if _, err := c.Resolve(ctx, unknown); err == nil {
			t.Fatalf("%s resolved", unknown)
		}
	}
}
