package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestFileSearchMatchesNameOrTextInEveryMode(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	attached, standalone := content.Sum([]byte("attached")), content.Sum([]byte("standalone"))
	id, err := st.InsertMessage(ctx, store.Message{Source: "mail", ExternalID: "invoice", SentAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if err = st.InsertAttachment(ctx, store.Attachment{MessageID: id, Filename: "invoice.pdf", SizeBytes: 8, BLAKE3: attached}); err != nil {
		t.Fatal(err)
	}
	file := library.File{Identity: library.Identity{Source: "files", Account: "owner", ExternalID: "report"}, BLAKE3: standalone, Filename: "report.pdf", SizeBytes: 10}
	if _, err = st.ImportLibrary(ctx, library.ImportBatch{Version: 1, Files: []library.File{file}}); err != nil {
		t.Fatal(err)
	}
	for digest, text := range map[content.Digest]string{attached: "payment due on the first", standalone: "quarterly review for Müller"} {
		if err = st.PutBlobText(ctx, store.BlobText{BLAKE3: digest, Text: text, Status: "ok"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		mode, query string
		attachments int
	}{
		{"any", "payment", 1}, {"any", "nothing", 0},
		{"all", "payment due", 1}, {"all", "invoice nothing", 0},
		{"all", `"due on the"`, 1}, {"all", `"the due"`, 0},
	} {
		matches, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Match: test.mode, Query: test.query})
		if err != nil || len(matches) != test.attachments {
			t.Errorf("attachments %s %q: %+v %v", test.mode, test.query, matches, err)
		}
	}
	if matches, err := st.AttachmentLibrary(ctx, store.AttachmentFilter{Query: "payment", Source: "other"}); err != nil || len(matches) != 0 {
		t.Errorf("attachment search ignored its source: %+v %v", matches, err)
	}
	for _, test := range []struct {
		mode, query string
		files       int
	}{
		{"any", "muller", 1}, {"all", "review quarterly", 1}, {"all", "report payment", 0}, {"all", `"quarterly review"`, 1},
	} {
		files, err := st.ListLibraryFiles(ctx, library.ListOptions{Match: test.mode, Query: test.query})
		if err != nil || len(files) != test.files {
			t.Errorf("library files %s %q: %+v %v", test.mode, test.query, files, err)
		}
	}
}
