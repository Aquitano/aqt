package aichat

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
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

	res, err := ImportChatGPT(ctx, st, nil, filepath.Join(dir, "archive"), path)
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

	res, err := ImportChatGPT(ctx, st, nil, filepath.Join(dir, "archive"), path)
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
	if _, err := st.GetThread(ctx, "chatgpt", "Postgres advice", 0); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("the old title-keyed thread survived: %v", err)
	}

	// A second pass changes nothing, which must not turn the duplicate into an
	// insert: the re-keying update returns no row when there is nothing to do.
	res, err = ImportChatGPT(ctx, st, nil, filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 0 || res.Duplicates != 1 {
		t.Errorf("unchanged re-import: %+v", res)
	}
}

// A tiny export directory: one conversation referencing one image (present),
// one upload (missing from the export) and one asset-only message.
const cgptAssetExport = `[{
  "title": "Screenshots",
  "conversation_id": "conv-1",
  "mapping": {
    "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
           "content": {"content_type": "multimodal_text", "parts": [
             {"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-Img1"},
             "what is on this screenshot?"]},
           "metadata": {"attachments": [{"id": "file-Img1", "name": "shot.png", "mime_type": "image/png"},
                                        {"id": "file-Gone", "name": "lost.pdf", "mime_type": "application/pdf"}]}}},
    "n2": {"message": {"id": "msg-2", "author": {"role": "user"}, "create_time": 1715629700.0,
           "content": {"content_type": "multimodal_text", "parts": [
             {"content_type": "image_asset_pointer", "asset_pointer": "sediment://file_00aa"}]}}}
  }
}]`

func writeChatGPTAssetExport(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("conversations.json", cgptAssetExport)
	write("file-Img1.dat", "PNG BYTES")
	write("file_00aa.dat", "SEDIMENT BYTES")
	write("conversation_asset_file_names.json", `{"file-Img1.dat": "shot.png"}`)
	return dir
}

func newBlobs(t *testing.T) *blob.Store {
	t.Helper()
	blobs, err := blob.New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return blobs
}

func TestImportChatGPTAttachments(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := writeChatGPTAssetExport(t)
	blobs := newBlobs(t)

	res, err := ImportChatGPT(ctx, st, blobs, filepath.Join(t.TempDir(), "archive"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 2 || res.Attachments != 2 || res.MissingMedia != 1 {
		t.Fatalf("result = %+v, want 2 messages, 2 stored assets, 1 missing", res)
	}

	// msg-1 carries the image; the missing upload left no attachment row.
	id, err := st.FindMessageID(ctx, "chatgpt", "msg-1")
	if err != nil || id == 0 {
		t.Fatalf("msg-1 not found: id=%d err=%v", id, err)
	}
	_, atts, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(atts) != 1 || atts[0].Filename != "shot.png" || atts[0].MimeType != "image/png" {
		t.Fatalf("msg-1 attachments = %+v", atts)
	}
	stored, err := os.ReadFile(blobs.Path(atts[0].SHA256))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "PNG BYTES" {
		t.Errorf("stored %q, want the .dat content", stored)
	}

	// The asset-only message must exist even with an empty body, its mime
	// sniffed since nothing named the sediment file.
	id2, err := st.FindMessageID(ctx, "chatgpt", "msg-2")
	if err != nil || id2 == 0 {
		t.Fatalf("asset-only message not imported: id=%d err=%v", id2, err)
	}
	_, atts2, err := st.GetMessage(ctx, id2)
	if err != nil {
		t.Fatal(err)
	}
	if len(atts2) != 1 || atts2[0].Filename != "file_00aa" || atts2[0].MimeType == "" {
		t.Fatalf("msg-2 attachments = %+v", atts2)
	}

	// Re-import is a clean no-op: nothing new, nothing doubled.
	again, err := ImportChatGPT(ctx, st, blobs, filepath.Join(t.TempDir(), "archive"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.Inserted != 0 || again.Duplicates != 2 || again.Attachments != 0 {
		t.Fatalf("re-import = %+v", again)
	}
	if _, atts, _ = st.GetMessage(ctx, id); len(atts) != 1 {
		t.Fatalf("re-import doubled attachments: %+v", atts)
	}
}

func TestImportChatGPTHealsTextOnlyImport(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := writeChatGPTAssetExport(t)
	blobs := newBlobs(t)

	// First pass from the bare conversations.json: messages without media,
	// including the asset-only message so missing references remain visible.
	first, err := ImportChatGPT(ctx, st, blobs, filepath.Join(t.TempDir(), "archive"), filepath.Join(dir, "conversations.json"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Inserted != 2 || first.Attachments != 0 || first.MissingMedia != 3 {
		t.Fatalf("text-only import = %+v, want both messages and all missing references", first)
	}

	// Re-import from the full directory attaches what the first pass could not.
	healed, err := ImportChatGPT(ctx, st, blobs, filepath.Join(t.TempDir(), "archive"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if healed.Attachments != 2 || healed.Inserted != 0 || healed.Duplicates != 2 {
		t.Fatalf("heal = %+v, want both present assets stored without adding duplicate messages", healed)
	}
	id, err := st.FindMessageID(ctx, "chatgpt", "msg-1")
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	if _, atts, _ := st.GetMessage(ctx, id); len(atts) != 1 {
		t.Fatalf("healed attachments = %+v", atts)
	}
}

func TestImportChatGPTHealsPartiallyPresentAssets(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := writeChatGPTAssetExport(t)
	blobs := newBlobs(t)
	archiveDir := filepath.Join(t.TempDir(), "archive")
	if _, err := ImportChatGPT(ctx, st, blobs, archiveDir, dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "file-Gone.dat"), []byte("NOW PRESENT"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := ImportChatGPT(ctx, st, blobs, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Attachments != 1 {
		t.Fatalf("reimport repaired %d attachments, want 1", res.Attachments)
	}
	id, _ := st.FindMessageID(ctx, "chatgpt", "msg-1")
	_, atts, err := st.GetMessage(ctx, id)
	if err != nil || len(atts) != 2 {
		t.Fatalf("attachments=%v err=%v", atts, err)
	}
	res, err = ImportChatGPT(ctx, st, blobs, archiveDir, dir)
	if err != nil || res.Attachments != 0 {
		t.Fatalf("repeat import=%+v err=%v", res, err)
	}
}
