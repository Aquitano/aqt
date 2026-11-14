package aichat

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
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
	if msgs, err := parseClaudeProject([]byte(raw)); !errors.Is(err, errStarterProject) {
		t.Fatalf("starter project imported: %+v %v", msgs, err)
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
	target := importtest.Target(t, claudeKind)
	path := exportZip(t, map[string]string{
		"projects/p-1.json": `{"uuid": "p-1", "name": "Uni", "description": "Course planning.",
		  "created_at": "2026-06-09T20:26:09+00:00",
		  "docs": [{"uuid": "d-1", "filename": "plan.md", "content": "DBI, DBII", "created_at": "2026-06-10T08:00:00+00:00"}]}`,
		"projects/p-2.json": `{"uuid": "p-2", "name": "How to use Claude", "is_starter_project": true}`,
	})

	got := importtest.MustImport(t, target, "claude", path, nil)
	if got.Report.Inserted != 2 || got.Report.Issues[ingest.Dropped] != 1 || got.Status != "complete" {
		t.Fatalf("import = %+v, want one project with two messages and the starter dropped", got)
	}
	id, err := target.Store.FindMessageID(context.Background(), "claude", "d-1")
	if err != nil || id == 0 {
		t.Fatalf("project doc not imported: id=%d err=%v", id, err)
	}

	again := importtest.MustImport(t, target, "claude", path, nil)
	if again.Report.Inserted != 0 || again.Report.Duplicates != 2 {
		t.Fatalf("re-import = %+v", again.Report)
	}
}

func TestImportClaudeMixedDirImportsBoth(t *testing.T) {
	target := importtest.Target(t, claudeKind)
	dir := filepath.Join(t.TempDir(), "claude-export")
	writeFile(t, dir, "conversations.json", `[{"uuid": "c-1", "name": "Bank schema", "chat_messages": [
	  {"uuid": "m-1", "sender": "human", "created_at": "2024-05-13T21:08:00Z", "text": "one datastore or two?", "content": []}]}]`)
	writeFile(t, dir, "memories/a-1.json", `{"conversations_memory": "Thomas studies in Passau.", "account_uuid": "a-1"}`)

	got := importtest.MustImport(t, target, "claude", dir, nil)
	if got.Report.Inserted != 2 {
		t.Fatalf("import = %+v, want the conversation and the memory both imported", got.Report)
	}
	ctx := context.Background()
	if id, err := target.Store.FindMessageID(ctx, "claude", "m-1"); err != nil || id == 0 {
		t.Errorf("conversation skipped in a mixed folder: id=%d err=%v", id, err)
	}
	threads, err := target.Store.GetThread(ctx, "claude", "memory", 0)
	if err != nil || len(threads.Messages) != 1 {
		t.Fatalf("memory thread: %+v %v", threads, err)
	}
	if !threads.Messages[0].SentAt.IsZero() {
		t.Errorf("memory sent_at = %v, want undated", threads.Messages[0].SentAt)
	}
}
