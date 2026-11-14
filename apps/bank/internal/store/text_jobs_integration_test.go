package store_test

import (
	"context"
	"testing"

	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertest"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/jobs"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

func withAttachment(externalID, filename string, d content.Digest) []store.Record {
	return []store.Record{{
		Message:     store.Message{Source: "proton", ExternalID: externalID, Sender: "alice@example.com", Body: "attached"},
		Attachments: []store.Attachment{{Filename: filename, MimeType: "application/pdf", SizeBytes: 1, BLAKE3: d}},
	}}
}

func contentID(t *testing.T, dsn string, d content.Digest) int64 {
	t.Helper()
	return pgschematest.QueryInt(t, dsn, `select id from contents where blake3 = $1`, d)
}

func TestAnAttachmentQueuesOneTextJobForItsContent(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	driver := riverpgxv5.New(storetest.Pool(t, dsn))

	if _, err := st.WriteMessages(ctx, withAttachment("m1", "invoice.pdf", digestA)); err != nil {
		t.Fatal(err)
	}
	job := rivertest.RequireInserted(ctx, t, driver, jobs.Text{}, nil)
	if job.Args.ContentID != contentID(t, dsn, digestA) {
		t.Fatalf("job for content %d", job.Args.ContentID)
	}

	if _, err := st.WriteMessages(ctx, withAttachment("m2", "forwarded.pdf", digestA)); err != nil {
		t.Fatal(err)
	}
	rivertest.RequireInserted(ctx, t, driver, jobs.Text{}, nil)
}

// The job is written in the import's transaction, so an import that fails
// at commit leaves neither the attachment nor its job behind.
func TestARolledBackImportLeavesNoJob(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	storetest.Exec(t, dsn, `
		create function refuse() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$;
		create constraint trigger refuse_at_commit after insert on attachments
			deferrable initially deferred for each row execute function refuse();`)

	if _, err := st.WriteMessages(ctx, withAttachment("m1", "invoice.pdf", digestA)); err == nil {
		t.Fatal("the commit should have failed")
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from river_job`); n != 0 {
		t.Fatalf("%d jobs outlived their rolled-back import", n)
	}
}

// Text a disk scan already read is the message's at once, and nothing queues
// the content again.
func TestContentAlreadyReadQueuesNothing(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	storetest.Exec(t, dsn, `
		with c as (insert into contents (blake3, size_bytes) values ($1, 1) returning id)
		insert into texts (content_id, status, text) select id, 'ok', 'pemberley lease' from c`, digestA)

	if _, err := st.WriteMessages(ctx, withAttachment("m1", "lease.pdf", digestA)); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from river_job`); n != 0 {
		t.Fatalf("%d jobs for content that has text", n)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from messages where attachment_text = 'pemberley lease'`); n != 1 {
		t.Fatal("the message does not search the text its attachment already had")
	}
}
