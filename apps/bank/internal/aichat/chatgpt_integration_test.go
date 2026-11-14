package aichat

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importer"
	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

var (
	chatgptKind = importer.Register(ChatGPT{}, "ChatGPT")
	claudeKind  = importer.Register(Claude{}, "Claude.ai")
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestImportChatGPTSkipsEmptyConversations(t *testing.T) {
	target := importtest.Target(t, chatgptKind)

	// The second conversation is all asset pointers none of which is a real
	// asset id, so it yields no message.
	export := `[
	  {"title": "Postgres advice", "mapping": {
	    "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	           "content": {"content_type": "text", "parts": ["how do I tune postgres?"]}}}}},
	  {"title": "Voice note", "mapping": {
	    "n1": {"message": {"id": "msg-2", "author": {"role": "user"}, "create_time": 1715629690.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://wav-1"}]}}}}}
	]`
	path := writeFile(t, t.TempDir(), "conversations.json", export)

	got := importtest.MustImport(t, target, "chatgpt", path, nil)
	if got.Report.Inserted != 1 || got.Report.Issues[ingest.Skipped] != 1 {
		t.Errorf("report = %+v, want one message and the empty conversation skipped", got.Report)
	}
}

// A tiny export: one conversation referencing one image (present), one upload
// (missing from the export) and one asset-only message.
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
	dir := filepath.Join(t.TempDir(), "chatgpt-export")
	writeFile(t, dir, "conversations.json", cgptAssetExport)
	writeFile(t, dir, "file-Img1.dat", "PNG BYTES")
	writeFile(t, dir, "file_00aa.dat", "SEDIMENT BYTES")
	writeFile(t, dir, "conversation_asset_file_names.json", `{"file-Img1.dat": "shot.png"}`)
	return dir
}

func attachments(t *testing.T, st *store.Store, externalID string) []store.Attachment {
	t.Helper()
	ctx := context.Background()
	id, err := st.FindMessageID(ctx, "chatgpt", externalID)
	if err != nil || id == 0 {
		t.Fatalf("%s not found: id=%d err=%v", externalID, id, err)
	}
	_, atts, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return atts
}

func TestImportChatGPTAttachments(t *testing.T) {
	target := importtest.Target(t, chatgptKind)
	dir := writeChatGPTAssetExport(t)

	got := importtest.MustImport(t, target, "chatgpt", dir, nil)
	if got.Report.Inserted != 2 || got.Report.Attachments != 2 || got.Report.Issues[ingest.MissingMedia] != 1 {
		t.Fatalf("report = %+v, want 2 messages, 2 stored assets, 1 missing", got.Report)
	}

	atts := attachments(t, target.Store, "msg-1")
	if len(atts) != 1 || atts[0].Filename != "shot.png" || atts[0].MimeType != "image/png" {
		t.Fatalf("msg-1 attachments = %+v", atts)
	}
	stored, err := os.ReadFile(target.Blobs.Path(atts[0].BLAKE3))
	if err != nil {
		t.Fatal(err)
	}
	if string(stored) != "PNG BYTES" {
		t.Errorf("stored %q, want the .dat content", stored)
	}

	// The asset-only message exists with an empty body, its mime sniffed
	// since nothing named the sediment file.
	if atts := attachments(t, target.Store, "msg-2"); len(atts) != 1 || atts[0].Filename != "file_00aa" || atts[0].MimeType == "" {
		t.Fatalf("msg-2 attachments = %+v", atts)
	}

	again := importtest.MustImport(t, target, "chatgpt", dir, nil)
	if again.Report.Inserted != 0 || again.Report.Duplicates != 2 || again.Report.Attachments != 0 {
		t.Fatalf("re-import = %+v", again.Report)
	}
}

// A bare conversations.json names every asset at the position the full
// export later fills.
func TestImportChatGPTTextOnlyThenFullExport(t *testing.T) {
	target := importtest.Target(t, chatgptKind)
	dir := writeChatGPTAssetExport(t)

	first := importtest.MustImport(t, target, "chatgpt", filepath.Join(dir, "conversations.json"), nil)
	if first.Report.Inserted != 2 || first.Report.Attachments != 0 || first.Report.Issues[ingest.MissingMedia] != 3 {
		t.Fatalf("text-only import = %+v, want both messages and all references missing", first.Report)
	}

	full := importtest.MustImport(t, target, "chatgpt", dir, nil)
	if full.Report.Attachments != 2 || full.Report.Inserted != 0 || full.Report.Duplicates != 2 {
		t.Fatalf("full import = %+v, want both present assets added to the stored messages", full.Report)
	}
	if atts := attachments(t, target.Store, "msg-1"); len(atts) != 1 || atts[0].Position != 0 {
		t.Fatalf("msg-1 attachments = %+v", atts)
	}
}
