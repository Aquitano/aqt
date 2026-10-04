package store_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/jackc/pgx/v5"
)

func TestBlobTextSearchMigrationPreservesOversizedDocuments(t *testing.T) {
	ctx := context.Background()
	st, schema := storetest.NewNamed(t)
	conn, err := pgx.Connect(ctx, storetest.SchemaDSN(t, schema))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	if _, err = conn.Exec(ctx, `drop index blob_text_oversized_search; drop index blob_text_search; alter table blob_text drop column search_vector; drop function blob_text_query_vector(text,text); drop function blob_text_search_vector(text)`); err != nil {
		t.Fatal(err)
	}
	sum := strings.Repeat("a", 64)
	if _, err = conn.Exec(ctx, `insert into blob_text(sha256,text,status) select $1,'phrase head ' || string_agg('term'||g,' ') || ' suffixneedle','ok' from generate_series(1,300000)g`, sum); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("migrations/0018_blob_text_search.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("existing large document blocked migration: %v", err)
	}
	var oversized bool
	if err = conn.QueryRow(ctx, `select search_vector is null from blob_text where sha256=$1`, sum).Scan(&oversized); err != nil || !oversized {
		t.Fatalf("oversized vector not guarded: %t %v", oversized, err)
	}
	id, err := st.InsertMessage(ctx, store.Message{Source: "mail", ExternalID: "oversized", SentAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "invoice.pdf", SHA256: sum}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ mode, query string }{{"any", "suffixneedle"}, {"all", "invoice suffixneedle"}, {"phrase", "phrase head"}, {"phrase", "pdf phrase"}} {
		matches, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Match: test.mode, Query: test.query})
		if err != nil || len(matches) != 1 {
			t.Fatalf("oversized %s %q: %+v %v", test.mode, test.query, matches, err)
		}
	}
	file := library.File{Identity: library.Identity{Source: "files", Account: "owner", ExternalID: "oversized"}, SHA256: sum, Filename: "invoice.pdf"}
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: []library.File{file}}); err != nil {
		t.Fatal(err)
	}
	files, err := st.ListLibraryFiles(ctx, library.ListOptions{Query: "invoice suffixneedle", Match: "all"})
	if err != nil || len(files) != 1 {
		t.Fatalf("oversized standalone text: %+v %v", files, err)
	}
	for i, document := range []string{"red-bird.txt foo@example.com a & b 123 foo-bar", "quiet ocean quasar quiet ocean", "a " + strings.Repeat("x", 3000) + " b", "it's a \\slash and quoted 'word'"} {
		query := document
		if i == 2 {
			query = "a b"
		}
		var equal bool
		if err = conn.QueryRow(ctx, `select blob_text_query_vector($1,$2)=to_tsvector('simple',$1)`, document, query).Scan(&equal); err != nil || !equal {
			t.Fatalf("simple token positions differ for fixture %d: %t %v", i, equal, err)
		}
	}
	if err = st.PutBlobText(ctx, store.BlobText{SHA256: sum, Text: "normal replacement", Status: "manual"}); err != nil {
		t.Fatal(err)
	}
	if err = conn.QueryRow(ctx, `select search_vector=to_tsvector('simple',text) from blob_text where sha256=$1`, sum).Scan(&oversized); err != nil || !oversized {
		t.Fatalf("normal vector not restored: %t %v", oversized, err)
	}
	t.Log("Migration accepted a 300000-term existing document; phrase, metadata/text and final token searches passed.")
}
