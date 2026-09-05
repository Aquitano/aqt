package aichat

import (
	"path/filepath"
	"testing"
)

const agThread = "936c185b-e763-47c1-be13-83e102df6fa3"

func TestParseAntigravityTranscript(t *testing.T) {
	raw := []byte(`{"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE", "created_at": "2026-08-10T19:24:26Z", "content": "<USER_REQUEST>\nwhat is herdr\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-10T19:24:26Z.\n</ADDITIONAL_METADATA>"}
{"step_index": 1, "source": "SYSTEM", "type": "CONVERSATION_HISTORY", "status": "DONE", "created_at": "2026-08-10T19:24:26Z"}
{"step_index": 2, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-08-10T19:24:26Z", "tool_calls": [{"name": "list_dir"}]}
{"step_index": 3, "source": "MODEL", "type": "LIST_DIRECTORY", "status": "DONE", "created_at": "2026-08-10T19:24:28Z", "content": "{\"name\":\".git\"}"}
{"step_index": 4, "source": "SYSTEM", "type": "CHECKPOINT", "status": "DONE", "created_at": "2026-08-10T19:24:28Z", "content": "{{ CHECKPOINT 0 }}\n\n# USER Objective:\nHerdr Configuration and Troubleshooting\n\n# Rest"}
{"step_index": 5, "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "created_at": "2026-08-10T19:26:21Z", "content": "Herdr is a terminal multiplexer."}
`)
	msgs, err := parseAntigravityTranscript(raw, agThread)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want user + assistant only: %+v", len(msgs), msgs)
	}
	if msgs[0].Sender != "user" || msgs[0].Body != "what is herdr" {
		t.Errorf("user message = %+v, want the USER_REQUEST unwrapped", msgs[0])
	}
	if msgs[0].ExternalID != agThread+"#0" || msgs[0].Thread != agThread {
		t.Errorf("ids = %q / %q", msgs[0].ExternalID, msgs[0].Thread)
	}
	if msgs[1].Sender != "assistant" || msgs[1].Body != "Herdr is a terminal multiplexer." || msgs[1].ExternalID != agThread+"#5" {
		t.Errorf("assistant message = %+v", msgs[1])
	}
	for _, m := range msgs {
		if m.Subject != "Herdr Configuration and Troubleshooting" {
			t.Errorf("subject = %q, want the checkpoint objective", m.Subject)
		}
	}
}

func TestAntigravityThreadID(t *testing.T) {
	cases := []struct {
		path, want string
	}{
		// The live layout: uuid three directories up.
		{filepath.Join("brain", agThread, ".system_generated", "logs", "transcript.jsonl"), agThread},
		{filepath.Join("brain", agThread, ".system_generated", "logs", "transcript_full.jsonl"), agThread},
		// A staged, uploaded or archived copy carries the uuid in its name.
		{agThread + "-transcript.jsonl", agThread},
		{filepath.Join("brain", "scratch", "transcript.jsonl"), ""},
	}
	for _, c := range cases {
		got, err := antigravityThreadID(c.path)
		if c.want == "" {
			if err == nil {
				t.Errorf("%s: expected an error, got %q", c.path, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: got %q, %v", c.path, got, err)
		}
	}
}
