package aichat

import (
	"context"
	"os"
	"path/filepath"
	"testing"

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
