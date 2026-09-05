package aichat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func codexRollout(lines ...string) string {
	return strings.Join(lines, "\n") + "\n"
}

func TestParseCodexSession(t *testing.T) {
	raw := codexRollout(
		`{"timestamp":"2026-08-18T17:10:44.956Z","type":"session_meta","payload":{"session_id":"sess-1","id":"file-1","thread_source":"user"}}`,
		`{"timestamp":"2026-08-18T17:10:45.349Z","type":"response_item","payload":{"type":"message","id":"msg-dev","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>...</skills_instructions>"}]}}`,
		`{"timestamp":"2026-08-18T17:10:45.350Z","type":"response_item","payload":{"type":"message","id":"msg-env","role":"user","content":[{"type":"input_text","text":"<environment_context>\n<cwd>/x</cwd>\n</environment_context>"}]}}`,
		`{"timestamp":"2026-08-18T17:10:45.351Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"build a docker compose"}]}}`,
		`{"timestamp":"2026-08-18T17:10:49.870Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking..."}]}}`,
		`{"timestamp":"2026-08-18T17:10:49.871Z","type":"response_item","payload":{"type":"message","id":"msg-a1","role":"assistant","content":[{"type":"output_text","text":"On it."}]}}`,
		`{"timestamp":"2026-08-18T17:10:50.000Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}`,
		`{"timestamp":"2026-08-18T17:11:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{}}}`,
	)
	msgs, subagent, err := parseCodexSession(strings.NewReader(raw), "fallback")
	if err != nil {
		t.Fatal(err)
	}
	if subagent {
		t.Fatal("user session reported as subagent")
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want 2 (context, developer, reasoning, tools dropped): %+v", len(msgs), msgs)
	}
	if msgs[0].Sender != "user" || msgs[0].Body != "build a docker compose" || msgs[0].Thread != "sess-1" {
		t.Errorf("user message = %+v", msgs[0])
	}
	if msgs[0].ExternalID == "" || msgs[0].ExternalID == "msg-env" {
		t.Errorf("user message without a payload id needs a derived one, got %q", msgs[0].ExternalID)
	}
	if msgs[1].ExternalID != "msg-a1" || msgs[1].Sender != "assistant" || msgs[1].Body != "On it." {
		t.Errorf("assistant message = %+v", msgs[1])
	}
	if msgs[1].SentAt.IsZero() || msgs[1].SentAt.Year() != 2026 {
		t.Errorf("sent_at = %v", msgs[1].SentAt)
	}
}

func TestParseCodexSessionSkipsSubagentThreads(t *testing.T) {
	raw := codexRollout(
		`{"timestamp":"2026-08-18T17:10:59.056Z","type":"session_meta","payload":{"session_id":"sess-1","id":"file-2","parent_thread_id":"sess-0","thread_source":"subagent"}}`,
		`{"timestamp":"2026-08-18T17:10:59.100Z","type":"response_item","payload":{"type":"message","id":"m","role":"user","content":[{"type":"input_text","text":"judge this action"}]}}`,
	)
	msgs, subagent, err := parseCodexSession(strings.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	if !subagent || len(msgs) != 0 {
		t.Fatalf("subagent=%v msgs=%d, want the whole thread dropped", subagent, len(msgs))
	}
}

// A repeated prompt ("continue", twice) must stay two messages: the derived
// id counts occurrences instead of hashing content alone. And re-parsing the
// same file must derive the same ids, or every re-import would duplicate the
// archive.
func TestParseCodexSessionDerivedIDs(t *testing.T) {
	raw := codexRollout(
		`{"timestamp":"2026-08-18T17:00:00.000Z","type":"session_meta","payload":{"session_id":"sess-1","id":"f","thread_source":"user"}}`,
		`{"timestamp":"2026-08-18T17:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}}`,
		`{"timestamp":"2026-08-18T17:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}}`,
	)
	first, _, err := parseCodexSession(strings.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || first[0].ExternalID == first[1].ExternalID {
		t.Fatalf("repeated prompts must get distinct ids: %+v", first)
	}
	again, _, err := parseCodexSession(strings.NewReader(raw), "")
	if err != nil {
		t.Fatal(err)
	}
	if first[0].ExternalID != again[0].ExternalID || first[1].ExternalID != again[1].ExternalID {
		t.Error("derived ids changed between parses of the same file")
	}
}

func TestParseCodexSessionFallsBackToFilenameThread(t *testing.T) {
	raw := codexRollout(
		`{"timestamp":"2026-08-18T17:00:01.000Z","type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"hello"}]}}`,
	)
	msgs, _, err := parseCodexSession(strings.NewReader(raw), "0199aaaa-bbbb-cccc-dddd-eeeeffff0000")
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || msgs[0].Thread != "0199aaaa-bbbb-cccc-dddd-eeeeffff0000" {
		t.Fatalf("msgs = %+v, want the filename uuid as thread", msgs)
	}
}

// Remote sync uploads what these list, so subagent files must be left out
// here, not just skipped server-side.
func TestUploadFileListsSkipSubagents(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("rollout-user.jsonl", `{"type":"session_meta","payload":{"session_id":"s","thread_source":"user"}}`+"\n")
	write("rollout-sub.jsonl", `{"type":"session_meta","payload":{"session_id":"s","thread_source":"subagent"}}`+"\n")
	files, err := codexFiles(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || filepath.Base(files[0]) != "rollout-user.jsonl" {
		t.Fatalf("codex upload list = %v", files)
	}

	write("agent-abc.jsonl", `{"type":"user"}`+"\n")
	write("11111111-2222-3333-4444-555555555555.jsonl", `{"type":"user"}`+"\n")
	files, err = claudeCodeFiles(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range files {
		names[filepath.Base(f)] = true
	}
	if names["agent-abc.jsonl"] || !names["11111111-2222-3333-4444-555555555555.jsonl"] {
		t.Fatalf("claude-code upload list = %v", files)
	}
}
