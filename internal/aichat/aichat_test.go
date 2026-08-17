package aichat

import (
	"encoding/json"
	"strings"
	"testing"
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
	if msgs[0].ExternalID != "msg-2" || msgs[0].Sender != "user" || msgs[0].Thread != "Postgres advice" {
		t.Errorf("first = %+v", msgs[0])
	}
	if !strings.Contains(msgs[1].Body, "shared_buffers") || !strings.Contains(msgs[1].Body, "work_mem") {
		t.Errorf("multi-part body = %q", msgs[1].Body)
	}
	if msgs[2].Body != "and an image above" {
		t.Errorf("multimodal non-string part not skipped: %q", msgs[2].Body)
	}
	if msgs[0].SentAt.Unix() != 1715629680 {
		t.Errorf("sent_at = %v", msgs[0].SentAt)
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
	if msgs[0].SentAt.Year() != 2024 || msgs[1].Thread != "Bank schema design" {
		t.Errorf("msgs = %+v", msgs)
	}
}

func TestParseClaudeCodeSession(t *testing.T) {
	lines := strings.Join([]string{
		`{"type":"summary","summary":"Fixing the mbox splitter","leafUuid":"x"}`,
		`{"type":"user","uuid":"u-1","timestamp":"2026-08-17T10:00:00.000Z","sessionId":"s1","message":{"role":"user","content":"the mbox import drops the last message"}}`,
		`{"type":"assistant","uuid":"a-1","timestamp":"2026-08-17T10:00:10.000Z","sessionId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"Looking at the splitter now."},{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}`,
		`{"type":"user","uuid":"u-2","timestamp":"2026-08-17T10:00:20.000Z","sessionId":"s1","isMeta":true,"message":{"role":"user","content":"meta line"}}`,
		`{"type":"user","uuid":"u-3","timestamp":"2026-08-17T10:00:30.000Z","sessionId":"s1","message":{"role":"user","content":[{"type":"tool_result","content":"file contents"}]}}`,
		`not json at all`,
	}, "\n")
	msgs, err := parseClaudeCodeSession(strings.NewReader(lines), "session-file")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (meta + tool_result-only skipped): %+v", len(msgs), msgs)
	}
	if msgs[0].Thread != "Fixing the mbox splitter" {
		t.Errorf("thread = %q", msgs[0].Thread)
	}
	if msgs[1].Body != "Looking at the splitter now." {
		t.Errorf("assistant body = %q (tool_use must be dropped)", msgs[1].Body)
	}
}

func unmarshal(s string, v any) error {
	return json.Unmarshal([]byte(s), v)
}
