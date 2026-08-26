package aichat

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newOpenCodeDB builds the slice of OpenCode's schema the importer reads.
func newOpenCodeDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "opencode.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, stmt := range []string{
		"CREATE TABLE session (id text PRIMARY KEY, parent_id text, title text NOT NULL)",
		"CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)",
		"CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, data text NOT NULL)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	return path, db
}

func TestReadOpenCodeDB(t *testing.T) {
	path, db := newOpenCodeDB(t)
	exec := func(stmt string, args ...any) {
		t.Helper()
		if _, err := db.Exec(stmt, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO session VALUES ('ses-1', NULL, 'Postgres tuning')`)
	exec(`INSERT INTO session VALUES ('ses-sub', 'ses-1', 'subagent task')`)
	exec(`INSERT INTO session VALUES ('ses-empty', NULL, 'never spoke')`)
	exec(`INSERT INTO message VALUES ('msg-1', 'ses-1', 1755500000000, '{"role":"user"}')`)
	exec(`INSERT INTO message VALUES ('msg-2', 'ses-1', 1755500001000, '{"role":"model"}')`)
	exec(`INSERT INTO message VALUES ('msg-3', 'ses-sub', 1755500002000, '{"role":"user"}')`)
	exec(`INSERT INTO part VALUES ('prt-1', 'msg-1', '{"type":"text","text":"how do I tune postgres?"}')`)
	exec(`INSERT INTO part VALUES ('prt-2', 'msg-2', '{"type":"step-start"}')`)
	exec(`INSERT INTO part VALUES ('prt-3', 'msg-2', '{"type":"text","text":"Start with shared_buffers."}')`)
	exec(`INSERT INTO part VALUES ('prt-4', 'msg-3', '{"type":"text","text":"machine prompt"}')`)

	var res Result
	byThread, err := readOpenCodeDB(context.Background(), path, &res)
	if err != nil {
		t.Fatal(err)
	}
	if len(byThread) != 1 {
		t.Fatalf("threads = %v, want only the top-level session", byThread)
	}
	msgs := byThread["ses-1"]
	if len(msgs) != 2 {
		t.Fatalf("got %d messages: %+v", len(msgs), msgs)
	}
	if msgs[0].ExternalID != "msg-1" || msgs[0].Sender != "user" || msgs[0].Subject != "Postgres tuning" {
		t.Errorf("first = %+v", msgs[0])
	}
	if msgs[0].SentAt.Year() != 2025 && msgs[0].SentAt.Year() != 2026 {
		t.Errorf("millisecond timestamp misread: %v", msgs[0].SentAt)
	}
	if msgs[1].Sender != "assistant" || msgs[1].Body != "Start with shared_buffers." {
		t.Errorf("model role not normalized or non-text part kept: %+v", msgs[1])
	}
	if res.SubagentSessions != 1 {
		t.Errorf("subagent sessions = %d, want the parented one counted", res.SubagentSessions)
	}
	if res.EmptyConversations != 1 {
		t.Errorf("empty conversations = %d, want the silent session counted", res.EmptyConversations)
	}
}

// The snapshot is what gets archived and uploaded, so it must carry the
// session rows, never modify the source, and never carry the OAuth tokens
// OpenCode keeps in its account tables.
func TestSnapshotOpenCodeDBSanitizes(t *testing.T) {
	path, db := newOpenCodeDB(t)
	for _, stmt := range []string{
		`INSERT INTO session VALUES ('ses-1', NULL, 't')`,
		`CREATE TABLE account (id text PRIMARY KEY, access_token text, refresh_token text)`,
		`INSERT INTO account VALUES ('a', 'secret-access', 'secret-refresh')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	snap, cleanup, err := snapshotOpenCodeDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if snap == path {
		t.Fatal("snapshot must never be the source file itself")
	}
	raw, err := os.ReadFile(snap)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "secret-access") {
		t.Fatal("snapshot still contains token bytes")
	}
	sdb, err := sql.Open("sqlite", "file:"+snap+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer sdb.Close()
	var n int
	if err := sdb.QueryRow(`SELECT count(*) FROM session`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("snapshot rows = %d, %v", n, err)
	}
	if err := sdb.QueryRow(`SELECT count(*) FROM account`).Scan(&n); err == nil {
		t.Fatal("account table survived sanitizing")
	}
	// The source must keep its credentials — sanitizing works on the copy.
	var token string
	if err := db.QueryRow(`SELECT access_token FROM account`).Scan(&token); err != nil || token != "secret-access" {
		t.Fatalf("source database was modified: %q, %v", token, err)
	}
}

// Two machines syncing into one server must not supersede each other's raw:
// a bare basename gains this host's discriminator, an already-discriminated
// one passes through unchanged.
func TestOpenCodeArchiveName(t *testing.T) {
	if got := openCodeArchiveName("opencode-laptop.db"); got != "opencode-laptop.db" {
		t.Errorf("discriminated name rewritten to %q", got)
	}
	got := openCodeArchiveName("opencode.db")
	if got == "opencode.db" || !strings.HasPrefix(got, "opencode-") || !strings.HasSuffix(got, ".db") {
		t.Errorf("bare name not discriminated: %q", got)
	}
}
