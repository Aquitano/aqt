package store_test

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// seedPreMessageIDUnique brings a schema up to the state it had before the
// Message-ID uniqueness migration, by running the real migration files and
// recording them as applied.
func seedPreMessageIDUnique(t *testing.T, dsn string) {
	t.Helper()
	storetest.Exec(t, dsn,
		`create table schema_migrations (filename text primary key, applied_at timestamptz not null default now())`)
	for _, name := range []string{"0001_init.sql", "0002_sync_state.sql", "0003_message_id.sql"} {
		sql, err := os.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		storetest.Exec(t, dsn, string(sql))
		storetest.Exec(t, dsn, `insert into schema_migrations (filename) values ($1)`, name)
	}
}

func TestMigrationCollapsesDuplicateMessageIDs(t *testing.T) {
	ctx := context.Background()
	dsn := storetest.NewEmpty(t)
	seedPreMessageIDUnique(t, dsn)

	// Two copies of one mail, as the old schema allowed: the Gmail API keyed
	// one by its API id, a Takeout mbox keyed the other by its Message-ID.
	// Each carries an attachment, and they share one of them.
	storetest.Exec(t, dsn, `
		insert into messages (source, external_id, message_id, sender, body, sent_at, raw_ref) values
			('gmail', 'api-1', 'dup@example.com', 'a@example.com', 'first copy',  '2024-05-13T21:08:00Z', 'gmail/api-1.eml'),
			('gmail', 'dup@example.com', 'dup@example.com', 'a@example.com', 'second copy', '2024-05-13T21:08:00Z', 'gmail/takeout.mbox'),
			('proton', 'dup@example.com', 'dup@example.com', 'a@example.com', 'other source', '2024-05-13T21:08:00Z', '')`)
	storetest.Exec(t, dsn, `
		insert into attachments (message_id, filename, mime_type, size_bytes, sha256)
		select id, 'shared.pdf', 'application/pdf', 3, 'aaaa' from messages where source = 'gmail'`)
	storetest.Exec(t, dsn, `
		insert into attachments (message_id, filename, mime_type, size_bytes, sha256)
		select id, 'only-on-loser.pdf', 'application/pdf', 3, 'bbbb'
		from messages where source = 'gmail' and external_id = 'dup@example.com'`)
	// The survivor legitimately holds the same file twice under one name,
	// which is a shape syncAttachments preserves on purpose.
	storetest.Exec(t, dsn, `
		insert into attachments (message_id, filename, mime_type, size_bytes, sha256)
		select id, 'twice.pdf', 'application/pdf', 3, 'cccc'
		from messages m, generate_series(1, 2)
		where m.source = 'gmail' and m.external_id = 'api-1'`)

	// This is the failure the migration has to survive: without dedup it
	// aborts, and every command that opens the database fails at startup.
	st := storetest.Open(t, dsn)

	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where source = 'gmail'`); n != 1 {
		t.Fatalf("%d gmail messages survived, want 1", n)
	}
	// The survivor is the lowest id, i.e. the copy ingested first.
	if body := pgschematest.QueryInt(t, dsn,
		`select count(*) from messages where source = 'gmail' and body = 'first copy'`); body != 1 {
		t.Error("the survivor is not the first-ingested copy")
	}
	// A different source keeping the same Message-ID is not a duplicate.
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where source = 'proton'`); n != 1 {
		t.Error("a different source was collapsed")
	}
	// Attachments moved to the survivor: the shared file kept exactly once,
	// the loser's own file kept, and the survivor's legitimate second copy of
	// twice.pdf untouched by the merge dedup.
	for _, want := range []struct {
		filename string
		count    int64
	}{{"twice.pdf", 2}, {"shared.pdf", 1}, {"only-on-loser.pdf", 1}} {
		if n := pgschematest.QueryInt(t, dsn, `
			select count(*) from attachments a join messages m on m.id = a.message_id
			where m.source = 'gmail' and a.filename = $1`, want.filename); n != want.count {
			t.Errorf("%s: %d rows on the survivor, want %d", want.filename, n, want.count)
		}
	}
	if n := pgschematest.QueryInt(t, dsn, `
		select count(*) from attachments a left join messages m on m.id = a.message_id where m.id is null`); n != 0 {
		t.Errorf("%d orphaned attachments", n)
	}
	// The deleted copy is auditable, named against the survivor that absorbed
	// it, so its raw archive file stays reachable.
	if n := pgschematest.QueryInt(t, dsn, `
		select count(*) from message_id_collapsed c join messages m on m.id = c.collapsed_into
		where c.source = 'gmail' and c.external_id = 'dup@example.com'
		  and c.raw_ref = 'gmail/takeout.mbox' and m.body = 'first copy'`); n != 1 {
		t.Errorf("the collapsed message was deleted without an audit row naming its survivor (%d matched)", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from message_id_collapsed`); n != 1 {
		t.Errorf("%d audit rows, want only the one deleted copy", n)
	}
	// The unique index exists and rejects later duplicates.
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'messages_source_message_id_key'`); n != 1 {
		t.Fatal("the unique partial index is missing after migration")
	}
	id, err := st.InsertMessage(ctx, store.Message{
		Source: "gmail", ExternalID: "api-2", MessageID: "dup@example.com",
		Body: "third copy", SentAt: time.Now(),
	})
	if err != nil || id != 0 {
		t.Fatalf("a later duplicate was not rejected idempotently: id=%d err=%v", id, err)
	}
}

// seedBefore applies and records every migration that sorts before stop.
func seedBefore(t *testing.T, dsn, stop string) {
	t.Helper()
	storetest.Exec(t, dsn, `create table schema_migrations (filename text primary key, applied_at timestamptz not null default now())`)
	files, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() >= stop {
			break
		}
		sql, err := os.ReadFile("migrations/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		storetest.Exec(t, dsn, string(sql))
		storetest.Exec(t, dsn, `insert into schema_migrations (filename) values ($1)`, file.Name())
	}
}

func TestAttachmentIngestionMigrationPreservesLegacyRows(t *testing.T) {
	dsn := storetest.NewEmpty(t)
	seedBefore(t, dsn, "0016_attachment_ingestion.sql")
	storetest.Exec(t, dsn, `insert into messages (source,external_id,sent_at,ingested_at) values ('proton','old',now(),'2000-01-01')`)
	storetest.Exec(t, dsn, `insert into attachments (message_id,filename,size_bytes,sha256) select id,'old.pdf',1,$1 from messages`, digestA)
	st := storetest.Open(t, dsn)
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from attachments where sha256=$1 and ingested_at is null`, digestA); n != 1 {
		t.Fatal("legacy attachment was assigned a new ingestion time")
	}
	if err := st.InsertAttachment(context.Background(), store.Attachment{MessageID: 1, Filename: "new.pdf", SizeBytes: 1, SHA256: digestB}); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from attachments where sha256=$1 and ingested_at > '2000-01-01'`, digestB); n != 1 {
		t.Fatal("new attachment did not receive an ingestion time")
	}
}

func TestForwardSlashMigrationRewritesOnlyWindowsRefs(t *testing.T) {
	dsn := storetest.NewEmpty(t)
	seedBefore(t, dsn, "0021_forward_slash_raw_refs.sql")
	storetest.Exec(t, dsn, `insert into messages (source,external_id,sent_at,raw_ref) values
		('mail','windows',now(),'mail\a.eml'),('mail','linux',now(),'mail/b\c.eml')`)
	storetest.Exec(t, dsn, `insert into library_items (id,source,account,external_id,kind,title,search_text,provenance)
		values ('item','netflix','','x','movie','X','X','{"raw_ref":"a\\b.json"}')`)
	storetest.Exec(t, dsn, `insert into library_item_evidence (item_id,raw_ref,locator) values ('item','a\b.json','row 1')`)
	storetest.Open(t, dsn)

	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where raw_ref in ('mail/a.eml','mail/b\c.eml')`); n != 2 {
		t.Errorf("%d message refs as expected, want 2", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from library_items i join library_item_evidence e on e.item_id = i.id
		where i.provenance->>'raw_ref' = 'a\b.json' and e.raw_ref = 'a\b.json'`); n != 1 {
		t.Error("a bundle-supplied library ref was rewritten")
	}
}

func TestConcurrentMigrationsSerialize(t *testing.T) {
	dsn := storetest.NewEmpty(t)

	const openers = 4
	var wg sync.WaitGroup
	errs := make([]error, openers)
	stores := make([]*store.Store, openers)
	for i := range openers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			stores[i], errs[i] = store.Open(context.Background(), dsn)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("opener %d: %v", i, err)
			continue
		}
		t.Cleanup(stores[i].Close)
	}
	if t.Failed() {
		return
	}
	files, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select version from public.schema_version`); n != int64(len(files)) {
		t.Errorf("schema version %d, want %d", n, len(files))
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from public.schema_version`); n != 1 {
		t.Errorf("%d version rows, want 1", n)
	}
	if n := pgschematest.QueryInt(t, dsn,
		`select count(*) from pg_indexes where schemaname = 'public' and indexname = 'messages_bm25_idx'`); n != 1 {
		t.Errorf("%d bm25 indexes, want exactly 1", n)
	}
}

func TestFailedMigrationLeavesARetryableState(t *testing.T) {
	dsn := storetest.NewEmpty(t)
	seedPreMessageIDUnique(t, dsn)
	// A relation already sitting on the name a later migration creates makes
	// that migration fail, which is the situation the lock has to survive.
	storetest.Exec(t, dsn, `create table messages_thread_idx ()`)

	if _, err := store.Open(context.Background(), dsn); err == nil {
		t.Fatal("a broken migration should surface, not be swallowed")
	}
	// The lock is released, so a retry gets as far as the same clear failure
	// instead of hanging.
	done := make(chan error, 1)
	go func() {
		_, err := store.Open(context.Background(), dsn)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the second attempt unexpectedly succeeded")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the migration lock was not released after a failure")
	}
}
