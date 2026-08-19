package aichat

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt-bank/internal/store"
	"github.com/aquitano/aqt-bank/internal/storetest"
)

func TestImportChatGPTCountsEmptyConversations(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	// The second conversation is all asset pointers, so it yields no message
	// and is dropped whole — the counter is the only trace it leaves.
	export := `[
	  {"title": "Postgres advice", "mapping": {
	    "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	           "content": {"content_type": "text", "parts": ["how do I tune postgres?"]}}}}},
	  {"title": "Voice note", "mapping": {
	    "n1": {"message": {"id": "msg-2", "author": {"role": "user"}, "create_time": 1715629690.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://wav-1"}]}}}}}
	]`
	path := filepath.Join(dir, "conversations.json")
	if err := os.WriteFile(path, []byte(export), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := ImportChatGPT(ctx, st, filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 1 || res.Inserted != 1 {
		t.Errorf("conversations = %d, inserted = %d: %+v", res.Conversations, res.Inserted, res)
	}
	if res.EmptyConversations != 1 {
		t.Errorf("empty conversations = %d, want the dropped one counted: %+v", res.EmptyConversations, res)
	}
}

// An archive filled before threads were keyed on conversation ids holds its
// messages under the title. Re-importing the same export must move them onto
// the id, and still count them as already known.
func TestImportChatGPTRekeysStoredMessages(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	if _, err := st.InsertMessage(ctx, store.Message{
		Source:     "chatgpt",
		ExternalID: "msg-1",
		ThreadID:   "Postgres advice", // what the old title-keyed import stored
		Sender:     "user",
		Body:       "how do I tune postgres?",
		SentAt:     time.Unix(1715629680, 0),
	}); err != nil {
		t.Fatal(err)
	}

	export := `[{"title": "Postgres advice", "conversation_id": "conv-1", "mapping": {
	  "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	         "content": {"content_type": "text", "parts": ["how do I tune postgres?"]}}}}}]`
	path := filepath.Join(dir, "conversations.json")
	if err := os.WriteFile(path, []byte(export), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := ImportChatGPT(ctx, st, filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 1 {
		t.Errorf("a re-keyed message is still already known: %+v", res)
	}
	th, err := st.GetThread(ctx, "chatgpt", "conv-1", 0)
	if err != nil {
		t.Fatalf("message was not re-keyed onto the conversation id: %v", err)
	}
	if len(th.Messages) != 1 || th.Messages[0].Subject != "Postgres advice" {
		t.Errorf("thread conv-1 = %+v, want the one message carrying the title as subject", th.Messages)
	}
	if _, err := st.GetThread(ctx, "chatgpt", "Postgres advice", 0); err != store.ErrNotFound {
		t.Errorf("the old title-keyed thread survived: %v", err)
	}

	// A second pass changes nothing, which must not turn the duplicate into an
	// insert: the re-keying update returns no row when there is nothing to do.
	res, err = ImportChatGPT(ctx, st, filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 1 {
		t.Errorf("unchanged re-import: %+v", res)
	}
}
