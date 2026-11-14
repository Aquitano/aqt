package aichat

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/library"
)

func TestParseChatGPTConversation(t *testing.T) {
	raw := `{
	  "title": "Postgres advice",
	  "conversation_id": "conv-1",
	  "mapping": {
	    "root": {"message": null},
	    "n1": {"message": {"id": "msg-1", "author": {"role": "system"}, "create_time": null,
	           "content": {"content_type": "text", "parts": [""]}}},
	    "n2": {"message": {"id": "msg-2", "author": {"role": "user"}, "create_time": 1715629680.5,
	           "content": {"content_type": "text", "parts": ["how do I tune postgres?"]}}},
	    "n3": {"message": {"id": "msg-3", "author": {"role": "assistant"}, "create_time": 1715629690.1,
	           "content": {"content_type": "text", "parts": ["Start with shared_buffers.", "Then work_mem."]}}},
	    "n4": {"message": {"id": "msg-4", "author": {"role": "assistant"}, "create_time": 1715629700.0,
	           "content": {"content_type": "multimodal_text", "parts": [{"asset_pointer": "file-x"}, "and an image above"]}}}
	  }
	}`
	var c cgptConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	msgs := parseChatGPTConversation(c)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 (system skipped): %+v", len(msgs), msgs)
	}
	if msgs[0].ExternalID != "msg-2" || msgs[0].Sender != "user" || msgs[0].Thread != "conv-1" || msgs[0].Subject != "Postgres advice" {
		t.Errorf("first = %+v", msgs[0])
	}
	if !strings.Contains(msgs[1].Body, "shared_buffers") || !strings.Contains(msgs[1].Body, "work_mem") {
		t.Errorf("multi-part body = %q", msgs[1].Body)
	}
	if msgs[2].Body != "and an image above" {
		t.Errorf("multimodal non-string part not skipped: %q", msgs[2].Body)
	}
	if msgs[0].SentAt.Unix() != 1715629680 || msgs[0].SentAt.Nanosecond() == 0 {
		t.Errorf("sent_at = %v, want the fractional second kept", msgs[0].SentAt)
	}
}

// A user question and its answer routinely share a whole second; the fraction
// must order them, and an exact tie must not depend on map iteration order.
func TestParseChatGPTConversationSubSecondOrder(t *testing.T) {
	raw := `{
	  "title": "Quick one",
	  "conversation_id": "conv-1",
	  "mapping": {
	    "n1": {"message": {"id": "msg-b", "author": {"role": "assistant"}, "create_time": 1715629680.75,
	           "content": {"content_type": "text", "parts": ["answer"]}}},
	    "n2": {"message": {"id": "msg-a", "author": {"role": "user"}, "create_time": 1715629680.25,
	           "content": {"content_type": "text", "parts": ["question"]}}},
	    "n3": {"message": {"id": "msg-c", "author": {"role": "user"}, "create_time": 1715629680.75,
	           "content": {"content_type": "text", "parts": ["follow-up at the same instant"]}}}
	  }
	}`
	var c cgptConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	for range 20 { // map iteration order varies per run
		msgs := parseChatGPTConversation(c)
		if got := msgs[0].ExternalID + "," + msgs[1].ExternalID + "," + msgs[2].ExternalID; got != "msg-a,msg-b,msg-c" {
			t.Fatalf("order = %s, want msg-a,msg-b,msg-c", got)
		}
	}
}

func TestParseChatGPTVoiceConversation(t *testing.T) {
	raw := `{
	  "title": "Vocabulary drills",
	  "mapping": {
	    "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "audio_transcription", "direction": "in", "text": "how do I learn vocabulary?"},
	             {"content_type": "audio_transcription", "direction": "in", "text": "   "},
	             {"content_type": "image_asset_pointer", "asset_pointer": "file-y", "text": "not a transcript"},
	             {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://wav-1"}]}}},
	    "n2": {"message": {"id": "msg-2", "author": {"role": "assistant"}, "create_time": 1715629690.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://wav-2"}]}}}
	  }
	}`
	var c cgptConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	msgs := parseChatGPTConversation(c)
	if len(msgs) != 1 {
		t.Fatalf("got %d messages, want the transcribed one only: %+v", len(msgs), msgs)
	}
	if msgs[0].Body != "how do I learn vocabulary?" {
		t.Errorf("body = %q (only the transcription part carries text)", msgs[0].Body)
	}
}

func TestParseChatGPTAssets(t *testing.T) {
	raw := `{
	  "title": "Screenshots",
	  "conversation_id": "conv-2",
	  "mapping": {
	    "n1": {"message": {"id": "msg-1", "author": {"role": "user"}, "create_time": 1715629680.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-Abc123", "size_bytes": 10},
	             "what is this?"]},
	           "metadata": {"attachments": [{"id": "file-Abc123", "name": "screen.png", "mime_type": "image/png"},
	                                        {"id": "file-Doc9", "name": "file-Doc9", "mimeType": "application/pdf"}]}}},
	    "n2": {"message": {"id": "msg-2", "author": {"role": "assistant"}, "create_time": 1715629690.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"content_type": "audio_asset_pointer", "metadata": null,
	              "audio_asset_pointer": {"asset_pointer": "sediment://file_00ff01", "content_type": "audio_asset_pointer"}}]}}},
	    "n3": {"message": {"id": "msg-3", "author": {"role": "user"}, "create_time": 1715629700.0,
	           "content": {"content_type": "multimodal_text", "parts": [
	             {"asset_pointer": "file-service://../../etc/passwd"}]}}}
	  }
	}`
	var c cgptConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	msgs := parseChatGPTConversation(c)
	// n3's only pointer is a traversal attempt, so with its reference refused
	// the message holds nothing and is dropped.
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (asset-only kept, traversal-only dropped): %+v", len(msgs), msgs)
	}
	if len(msgs[0].Attachments) != 2 {
		t.Fatalf("first message attachments = %+v, want image (deduped with its pointer) + upload", msgs[0].Attachments)
	}
	img := msgs[0].Attachments[0]
	if img.ID != "file-Abc123" || img.Name != "screen.png" || img.Mime != "image/png" {
		t.Errorf("image ref = %+v", img)
	}
	doc := msgs[0].Attachments[1]
	if doc.ID != "file-Doc9" || doc.Name != "" || doc.Mime != "application/pdf" {
		t.Errorf("upload ref = %+v (id-as-name must be dropped, mimeType spelling read)", doc)
	}
	if len(msgs[1].Attachments) != 1 || msgs[1].Attachments[0].ID != "file_00ff01" {
		t.Errorf("nested audio pointer = %+v", msgs[1].Attachments)
	}
	if msgs[1].Body != "" {
		t.Errorf("audio-only body = %q", msgs[1].Body)
	}
}

func TestAssetID(t *testing.T) {
	cases := map[string]string{
		"file-service://file-Abc123":     "file-Abc123",
		"sediment://file_00ff01":         "file_00ff01",
		"file-service://../etc/passwd":   "",
		"file-service://file-a/../../b":  "",
		"file-Abc123":                    "",
		"sediment://":                    "",
		"file-service://file_0f.dat":     "",
		"https://example.com/file-Abc12": "",
	}
	for in, want := range cases {
		if got := assetID(in); got != want {
			t.Errorf("assetID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseClaudeConversation(t *testing.T) {
	raw := `{
	  "uuid": "c-1", "name": "Bank schema design",
	  "chat_messages": [
	    {"uuid": "m-1", "sender": "human", "created_at": "2024-05-13T21:08:00.123456+00:00",
	     "text": "", "content": [{"type": "text", "text": "one datastore or two?"}]},
	    {"uuid": "m-2", "sender": "assistant", "created_at": "2024-05-13T21:08:30Z",
	     "text": "One. ParadeDB gives BM25 in Postgres.", "content": []}
	  ]
	}`
	var c claudeConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	msgs := parseClaudeConversation(c)
	if len(msgs) != 2 {
		t.Fatalf("got %d messages: %+v", len(msgs), msgs)
	}
	if msgs[0].Sender != "user" || msgs[0].Body != "one datastore or two?" {
		t.Errorf("human message = %+v", msgs[0])
	}
	if msgs[0].SentAt.Year() != 2024 || msgs[1].Thread != "c-1" || msgs[1].Subject != "Bank schema design" {
		t.Errorf("msgs = %+v", msgs)
	}
}

// A conversation whose messages carry no text must parse to nothing, so it is
// reported as skipped instead of stored with empty bodies.
func TestParseClaudeConversationWithoutText(t *testing.T) {
	raw := `{
	  "uuid": "c-2", "name": "Screenshots only",
	  "chat_messages": [
	    {"uuid": "m-1", "sender": "human", "created_at": "2024-05-13T21:08:00Z",
	     "text": "  ", "content": [{"type": "image", "text": ""}]},
	    {"uuid": "m-2", "sender": "assistant", "created_at": "2024-05-13T21:08:30Z",
	     "text": "", "content": []}
	  ]
	}`
	var c claudeConversation
	if err := unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if msgs := parseClaudeConversation(c); len(msgs) != 0 {
		t.Errorf("got %d messages, want none: %+v", len(msgs), msgs)
	}
}

// Titles repeat — a ChatGPT export holds dozens of "New chat" — so two
// conversations sharing one must still be two threads.
func TestSameTitleConversationsStayApart(t *testing.T) {
	chatgpt := func(id string) []message {
		var c cgptConversation
		if err := unmarshal(`{"title": "New chat", "conversation_id": "`+id+`", "mapping": {
		  "n1": {"message": {"id": "`+id+`-m", "author": {"role": "user"}, "create_time": 1715629680.0,
		         "content": {"content_type": "text", "parts": ["hi"]}}}}}`, &c); err != nil {
			t.Fatal(err)
		}
		return parseChatGPTConversation(c)
	}
	claude := func(uuid string) []message {
		var c claudeConversation
		if err := unmarshal(`{"uuid": "`+uuid+`", "name": "New chat", "chat_messages": [
		  {"uuid": "`+uuid+`-m", "sender": "human", "created_at": "2024-05-13T21:08:00Z", "text": "hi"}]}`, &c); err != nil {
			t.Fatal(err)
		}
		return parseClaudeConversation(c)
	}
	for _, tc := range []struct {
		source string
		parse  func(string) []message
		ids    [2]string
	}{
		{"chatgpt", chatgpt, [2]string{"conv-1", "conv-2"}},
		{"claude", claude, [2]string{"c-1", "c-2"}},
	} {
		t.Run(tc.source, func(t *testing.T) {
			first, second := tc.parse(tc.ids[0]), tc.parse(tc.ids[1])
			if len(first) != 1 || len(second) != 1 {
				t.Fatalf("got %d and %d messages, want one each", len(first), len(second))
			}
			if first[0].Thread != tc.ids[0] || second[0].Thread != tc.ids[1] {
				t.Errorf("threads = %q and %q, want the conversation ids", first[0].Thread, second[0].Thread)
			}
			if first[0].Subject != "New chat" || second[0].Subject != "New chat" {
				t.Errorf("subjects = %q and %q, want the shared title", first[0].Subject, second[0].Subject)
			}
		})
	}
}

func unmarshal(s string, v any) error {
	return json.Unmarshal([]byte(s), v)
}

// conversation is a ChatGPT conversation with one user message.
func conversation(id string) string {
	return `{"title":"` + id + `","conversation_id":"` + id + `","mapping":{"n":{"message":{"id":"` + id + `-m","author":{"role":"user"},"create_time":1715629680.0,"content":{"content_type":"text","parts":["hi"]}}}}}`
}

// The files of a sharded export: two conversation shards plus the neighbour a
// loose conversations*.json glob would wrongly pick up.
var shardedExport = map[string]string{
	"conversations-000.json":             "[" + conversation("c-1") + "]",
	"conversations-001.json":             "[" + conversation("c-2") + "," + conversation("c-3") + "]",
	"conversation_asset_file_names.json": `{"file-x.dat":"image.png"}`,
	"user.json":                          `{"id":"u-1"}`,
}

func TestChatGPTShardedExport(t *testing.T) {
	got, err := parseInput(ChatGPT{}, exportZip(t, shardedExport))
	if err != nil {
		t.Fatal(err)
	}
	if threads := got.threads(); threads != "c-1,c-2,c-3" || len(got.issues) != 0 {
		t.Fatalf("threads = %s, issues = %+v, want the shards read in shard order", threads, got.issues)
	}
	if got.messages[1].Locator != "conversations-001.json: conversation c-2" {
		t.Errorf("locator = %q", got.messages[1].Locator)
	}
}

func TestChatGPTMissingShardIsIncomplete(t *testing.T) {
	got, err := parseInput(ChatGPT{}, exportZip(t, map[string]string{
		"conversations-000.json": "[" + conversation("c-1") + "]",
		"conversations-002.json": "[" + conversation("c-3") + "]",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if threads := got.threads(); threads != "c-1,c-3" {
		t.Errorf("threads = %s", threads)
	}
	if len(got.issues) != 1 || got.issues[0].Kind != ingest.Incomplete {
		t.Errorf("issues = %+v, want the missing shard", got.issues)
	}
}

func TestChatGPTWithoutConversations(t *testing.T) {
	path := exportZip(t, map[string]string{"user.json": `{"id":"u-1"}`, "conversation_asset_file_names.json": `{}`})
	if _, err := parseInput(ChatGPT{}, path); err == nil {
		t.Error("want an error for an export holding no conversations")
	}
}

func TestConversationFilesOrdersByNumber(t *testing.T) {
	// Unpadded shards: lexically conversations-10.json sorts first.
	names, _, err := conversationFiles(fstest.MapFS{
		"conversations-9.json":  {Data: []byte(`[]`)},
		"conversations-10.json": {Data: []byte(`[]`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != "conversations-9.json,conversations-10.json" {
		t.Errorf("names = %v", names)
	}
}

func TestMissingShards(t *testing.T) {
	for _, tc := range []struct {
		name string
		nums []int
		want []int
	}{
		{"contiguous", []int{0, 1, 2}, nil},
		{"a hole", []int{0, 1, 3, 4}, []int{2}},
		{"several holes", []int{0, 3, 5, 9}, []int{1, 2, 4, 6, 7, 8}},
		// An export that numbers from 1 is complete, not missing a zeroth.
		{"starting late", []int{7, 8}, nil},
		{"one shard", []int{4}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shards := make([]shard, len(tc.nums))
			for i, n := range tc.nums {
				shards[i] = shard{num: n, name: fmt.Sprintf("conversations-%03d.json", n)}
			}
			got := missingShards(shards)
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("missingShards(%v) = %v, want %v", tc.nums, got, tc.want)
			}
		})
	}
}

// recorder is an Emitter that keeps what a source emits.
type recorder struct {
	messages []ingest.Message
	issues   []ingest.Issue
}

func (r *recorder) Message(m ingest.Message) error {
	r.messages = append(r.messages, m)
	return nil
}
func (r *recorder) Library(library.ImportBatch) error { return nil }
func (r *recorder) Pages(ingest.Pages) error          { return nil }
func (r *recorder) Issue(i ingest.Issue)              { r.issues = append(r.issues, i) }

func (r *recorder) threads() string {
	threads := make([]string, len(r.messages))
	for i, m := range r.messages {
		threads[i] = m.ThreadID
	}
	return strings.Join(threads, ",")
}

func parseInput(src ingest.Source[Options], path string) (*recorder, error) {
	got := &recorder{}
	err := src.Parse(context.Background(), ingest.Raw{Name: filepath.Base(path), Path: path}, Options{}, got)
	return got, err
}

func exportZip(t *testing.T, parts map[string]string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "export.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	zw := zip.NewWriter(f)
	for name, content := range parts {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
