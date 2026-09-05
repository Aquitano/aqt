package aichat

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/archive"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

// The full bank reimport round trip: an export already in the archive is
// listed, staged back under its original name and fed to the importer, which
// repairs what the import that archived it got wrong — here the old
// title-keyed thread — without adding anything to the archive.
func TestReimportRekeysFromArchive(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	archiveDir := t.TempDir()

	export := `[{"title": "Postgres advice", "conversation_id": "conv-1", "mapping": {
	  "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	         "content": {"content_type": "text", "parts": ["how do I tune postgres?"]}}}}}]`
	src := filepath.Join(t.TempDir(), "conversations.json")
	if err := os.WriteFile(src, []byte(export), 0o600); err != nil {
		t.Fatal(err)
	}
	ref, err := archive.Copy(archiveDir, "chatgpt", src)
	if err != nil {
		t.Fatal(err)
	}
	// The message as the import that archived this export stored it, back
	// when threads were keyed on the title.
	if _, err := st.InsertMessage(ctx, store.Message{
		Source:     "chatgpt",
		ExternalID: "msg-1",
		ThreadID:   "Postgres advice",
		Sender:     "user",
		Body:       "how do I tune postgres?",
		SentAt:     time.Unix(1715629680, 0),
	}); err != nil {
		t.Fatal(err)
	}

	entries, err := archive.List(archiveDir, "chatgpt")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Ref != ref {
		t.Fatalf("entries = %+v, want the one archived export", entries)
	}
	staged, err := archive.Stage(archiveDir, entries[0], t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(staged) != "conversations.json" {
		t.Fatalf("staged as %q, want the original name back", staged)
	}

	res, err := ImportChatGPT(ctx, st, nil, archiveDir, staged)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 1 {
		t.Errorf("replay must re-key, not re-insert: %+v", res)
	}
	if _, err := st.GetThread(ctx, "chatgpt", "conv-1", 0); err != nil {
		t.Errorf("message was not re-keyed onto the conversation id: %v", err)
	}
	if _, err := st.GetThread(ctx, "chatgpt", "Postgres advice", 0); err != store.ErrNotFound {
		t.Errorf("the old title-keyed thread survived: %v", err)
	}

	// The importer re-archived the staged copy, which must have deduped onto
	// the existing reference instead of growing the archive.
	after, err := archive.List(archiveDir, "chatgpt")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 {
		t.Errorf("archive grew during replay: %+v", after)
	}
}
