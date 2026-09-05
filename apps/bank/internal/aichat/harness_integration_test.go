package aichat

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestImportCodexEndToEnd(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	user := codexRollout(
		`{"timestamp":"2026-08-18T17:00:00.000Z","type":"session_meta","payload":{"session_id":"sess-1","id":"f1","thread_source":"user"}}`,
		`{"timestamp":"2026-08-18T17:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"fix the build"}]}}`,
		`{"timestamp":"2026-08-18T17:00:02.000Z","type":"response_item","payload":{"type":"message","id":"msg-a","role":"assistant","content":[{"type":"output_text","text":"Done."}]}}`,
	)
	subagent := codexRollout(
		`{"timestamp":"2026-08-18T17:00:03.000Z","type":"session_meta","payload":{"session_id":"sess-1","id":"f2","thread_source":"subagent"}}`,
		`{"timestamp":"2026-08-18T17:00:04.000Z","type":"response_item","payload":{"type":"message","id":"m","role":"user","content":[{"type":"input_text","text":"judge this"}]}}`,
	)
	for name, content := range map[string]string{"a-user.jsonl": user, "b-sub.jsonl": subagent} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	archiveDir := filepath.Join(t.TempDir(), "archive")
	res, err := ImportCodex(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 1 || res.Inserted != 2 || res.SubagentSessions != 1 {
		t.Fatalf("first import = %+v", res)
	}
	again, err := ImportCodex(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.Inserted != 0 || again.Duplicates != 2 {
		t.Fatalf("re-import must be idempotent: %+v", again)
	}

	// A sync skips the archived-identical session without touching the store;
	// the subagent file was never archived and is re-recognized as such.
	synced, err := SyncCodex(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if synced.UnchangedSessions != 1 || synced.SubagentSessions != 1 || synced.Inserted != 0 || synced.Duplicates != 0 {
		t.Fatalf("sync of unchanged sessions = %+v", synced)
	}

	// A grown rollout re-imports: old messages dedup, the new one lands, and
	// the archive still holds exactly one superseded copy of the file.
	grown := user + `{"timestamp":"2026-08-18T17:00:05.000Z","type":"response_item","payload":{"type":"message","id":"msg-b","role":"assistant","content":[{"type":"output_text","text":"And tested."}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "a-user.jsonl"), []byte(grown), 0o600); err != nil {
		t.Fatal(err)
	}
	synced, err = SyncCodex(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if synced.Inserted != 1 || synced.Duplicates != 2 || synced.UnchangedSessions != 0 {
		t.Fatalf("sync of a grown session = %+v", synced)
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "codex"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("archive holds %d codex files, want the one superseded copy", len(entries))
	}
}

func TestImportAntigravityEndToEnd(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	logs := filepath.Join(dir, "brain", agThread, ".system_generated", "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	step := `{"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": "2026-08-10T19:24:26Z", "content": "<USER_REQUEST>truncated</USER_REQUEST>"}` + "\n"
	full := `{"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": "2026-08-10T19:24:26Z", "content": "<USER_REQUEST>the full text</USER_REQUEST>"}` + "\n"
	if err := os.WriteFile(filepath.Join(logs, "transcript.jsonl"), []byte(step), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logs, "transcript_full.jsonl"), []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}

	archiveDir := filepath.Join(dir, "archive")
	res, err := ImportAntigravity(ctx, st, archiveDir, filepath.Join(dir, "brain"))
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 1 || res.Inserted != 1 {
		t.Fatalf("first import = %+v", res)
	}
	hits, err := st.Search(ctx, "full text", store.SearchOpts{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("want the transcript_full body imported, got %d hits", len(hits))
	}
	again, err := ImportAntigravity(ctx, st, archiveDir, filepath.Join(dir, "brain"))
	if err != nil {
		t.Fatal(err)
	}
	if again.Inserted != 0 || again.Duplicates != 1 {
		t.Fatalf("re-import must be idempotent: %+v", again)
	}
	synced, err := SyncAntigravity(ctx, st, archiveDir, filepath.Join(dir, "brain"))
	if err != nil {
		t.Fatal(err)
	}
	if synced.UnchangedSessions != 1 || synced.Inserted != 0 || synced.Duplicates != 0 {
		t.Fatalf("sync of an unchanged transcript = %+v", synced)
	}
}

func TestImportOpenCodeEndToEnd(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)

	path, db := newOpenCodeDB(t)
	for _, stmt := range []string{
		`INSERT INTO session VALUES ('ses-1', NULL, 'a title')`,
		`INSERT INTO message VALUES ('msg-1', 'ses-1', 1755500000000, '{"role":"user"}')`,
		`INSERT INTO part VALUES ('prt-1', 'msg-1', '{"type":"text","text":"hello opencode"}')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	archiveDir := filepath.Join(t.TempDir(), "archive")
	res, err := ImportOpenCode(ctx, st, archiveDir, path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Conversations != 1 || res.Inserted != 1 {
		t.Fatalf("first import = %+v", res)
	}
	again, err := ImportOpenCode(ctx, st, archiveDir, path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Inserted != 0 || again.Duplicates != 1 {
		t.Fatalf("re-import must be idempotent: %+v", again)
	}
	// The database file is unchanged, so its sanitized snapshot is
	// byte-identical to the archived one and the sync skips it whole.
	synced, err := SyncOpenCode(ctx, st, archiveDir, path)
	if err != nil {
		t.Fatal(err)
	}
	if synced.UnchangedSessions != 1 || synced.Inserted != 0 || synced.Duplicates != 0 {
		t.Fatalf("sync of an unchanged database = %+v", synced)
	}
}

func TestSyncClaudeCodeSkipsUnchanged(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	line := `{"type":"user","uuid":"u-1","timestamp":"2026-08-17T10:00:00.000Z","message":{"role":"user","content":"first"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	archiveDir := filepath.Join(t.TempDir(), "archive")
	res, err := SyncClaudeCode(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 {
		t.Fatalf("first sync = %+v", res)
	}
	res, err = SyncClaudeCode(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.UnchangedSessions != 1 || res.Inserted != 0 || res.Duplicates != 0 {
		t.Fatalf("second sync = %+v, want the session skipped as unchanged", res)
	}
	grown := line + `{"type":"assistant","uuid":"a-1","timestamp":"2026-08-17T10:00:05.000Z","message":{"role":"assistant","content":"reply"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(grown), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = SyncClaudeCode(ctx, st, archiveDir, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 || res.Duplicates != 1 || res.UnchangedSessions != 0 {
		t.Fatalf("sync of a grown session = %+v", res)
	}
	entries, err := os.ReadDir(filepath.Join(archiveDir, "claude-code"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("archive holds %d files, want the one superseded copy", len(entries))
	}
}
