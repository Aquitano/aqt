package aichat

import (
	"archive/zip"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestParseClaudeProject(t *testing.T) {
	raw := `{
	  "uuid": "p-1", "name": "Uni", "description": "Course planning.",
	  "is_private": true, "is_starter_project": false, "prompt_template": "Answer in German.",
	  "created_at": "2026-06-09T20:26:09.654289+00:00",
	  "docs": [
	    {"uuid": "d-1", "filename": "modulplan.md", "content": "# Plan\nDBI, DBII", "created_at": "2026-06-10T08:00:00+00:00"},
	    {"uuid": "d-2", "filename": "empty.md", "content": "   ", "created_at": "2026-06-10T08:00:00+00:00"}
	  ]
	}`
	msgs, err := parseClaudeProject([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want description + one non-empty doc: %+v", len(msgs), msgs)
	}
	if msgs[0].Thread != "p-1" || msgs[0].Subject != "Uni" || msgs[0].Body != "Course planning.\n\nAnswer in German." {
		t.Errorf("project message = %+v", msgs[0])
	}
	if msgs[1].ExternalID != "d-1" || msgs[1].Subject != "Uni — modulplan.md" || msgs[1].Sender != "user" {
		t.Errorf("doc message = %+v", msgs[1])
	}
}

func TestParseClaudeProjectSkipsStarter(t *testing.T) {
	raw := `{"uuid": "p-2", "name": "How to use Claude", "is_starter_project": true,
	  "docs": [{"uuid": "d-9", "filename": "guide.md", "content": "Anthropic's onboarding text"}]}`
	msgs, err := parseClaudeProject([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("starter project imported: %+v", msgs)
	}
}

func TestParseClaudeMemoryVersionsByContent(t *testing.T) {
	raw := `{"conversations_memory": "Thomas studies in Passau.",
	  "project_memories": {"p-1": "Formal German emails."}, "account_uuid": "a-1"}`
	msgs, err := parseClaudeMemory([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || msgs[0].Thread != "memory" || msgs[1].Subject != "Claude project memory p-1" {
		t.Fatalf("memory messages = %+v", msgs)
	}
	changed, err := parseClaudeMemory([]byte(`{"conversations_memory": "Thomas moved to Lisbon.", "account_uuid": "a-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if changed[0].ExternalID == msgs[0].ExternalID {
		t.Error("rewritten memory kept the same external id — the new version would be dropped as a duplicate")
	}
}

func TestParseClaudeDesignChat(t *testing.T) {
	raw := `{
	  "uuid": "dc-1", "title": "Chat", "project": {"uuid": "p-3", "name": "Health app dashboard redesign"},
	  "messages": [
	    {"uuid": "m-1", "role": "user", "created_at": "2026-06-27T21:36:24+00:00",
	     "content": {"content": "Design the frontend.", "timestamp": "2026-06-27T21:36:25Z"}},
	    {"uuid": "m-2", "role": "assistant", "created_at": "2026-06-27T21:36:51+00:00",
	     "content": {"content": "", "contentBlocks": [
	       {"type": "tool_call", "toolCall": {"name": "list_files"}},
	       {"type": "text", "text": "Building two directions now."}]}},
	    {"uuid": "m-3", "role": "assistant", "created_at": "2026-06-27T21:37:00+00:00",
	     "content": {"content": "", "contentBlocks": [{"type": "tool_call", "toolCall": {"name": "dc_write"}}]}}
	  ]
	}`
	msgs, err := parseClaudeDesignChat([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("got %d messages, want the tool-only turn dropped: %+v", len(msgs), msgs)
	}
	if msgs[0].Thread != "dc-1" || msgs[0].Subject != "Health app dashboard redesign — Chat" {
		t.Errorf("first = %+v", msgs[0])
	}
	if msgs[1].Body != "Building two directions now." {
		t.Errorf("text-block fallback body = %q", msgs[1].Body)
	}
}

func TestImportClaudeExtrasZip(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	zipPath := filepath.Join(dir, "projects-000.zip")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("projects/p-1.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(`{"uuid": "p-1", "name": "Uni", "description": "Course planning.",
	  "created_at": "2026-06-09T20:26:09+00:00",
	  "docs": [{"uuid": "d-1", "filename": "plan.md", "content": "DBI, DBII", "created_at": "2026-06-10T08:00:00+00:00"}]}`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	f.Close()

	res, err := ImportClaude(ctx, st, filepath.Join(dir, "archive"), zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 1 || res.Inserted != 2 {
		t.Fatalf("result = %+v, want one project with two messages", res)
	}
	id, err := st.FindMessageID(ctx, "claude", "d-1")
	if err != nil || id == 0 {
		t.Fatalf("project doc not imported: id=%d err=%v", id, err)
	}

	again, err := ImportClaude(ctx, st, filepath.Join(dir, "archive"), zipPath)
	if err != nil {
		t.Fatal(err)
	}
	if again.Inserted != 0 || again.Duplicates != 2 {
		t.Fatalf("re-import = %+v", again)
	}
}

func TestImportClaudeMixedDirImportsBoth(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	convs := `[{"uuid": "c-1", "name": "Bank schema", "chat_messages": [
	  {"uuid": "m-1", "sender": "human", "created_at": "2024-05-13T21:08:00Z", "text": "one datastore or two?", "content": []}]}]`
	if err := os.WriteFile(filepath.Join(dir, "conversations.json"), []byte(convs), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "memories"), 0o700); err != nil {
		t.Fatal(err)
	}
	mem := `{"conversations_memory": "Thomas studies in Passau.", "account_uuid": "a-1"}`
	if err := os.WriteFile(filepath.Join(dir, "memories", "a-1.json"), []byte(mem), 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := ImportClaude(ctx, st, filepath.Join(dir, "archive"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 2 || res.Inserted != 2 {
		t.Fatalf("result = %+v, want the conversation and the memory both imported", res)
	}
	if id, err := st.FindMessageID(ctx, "claude", "m-1"); err != nil || id == 0 {
		t.Errorf("conversation skipped in a mixed folder: id=%d err=%v", id, err)
	}
}
