package aichat

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt-bank/internal/storetest"
)

func TestImportClaudeCodeContinuesPastABadSession(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()

	session := func(name, uuid, text string) {
		line := `{"type":"user","uuid":"` + uuid + `","timestamp":"2026-08-17T10:00:00.000Z",` +
			`"message":{"role":"user","content":"` + text + `"}}`
		if err := os.WriteFile(filepath.Join(dir, name), []byte(line+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Alphabetical order matters: the unreadable file is walked before the
	// last good one, so a fail-fast walk would lose it.
	session("a-first.jsonl", "u-1", "first session")
	if err := os.WriteFile(filepath.Join(dir, "b-broken.jsonl"), []byte("{\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	session("c-last.jsonl", "u-2", "last session")

	if os.Geteuid() == 0 {
		t.Skip("root can read a 0000 file, so the failure cannot be staged")
	}
	res, err := ImportClaudeCode(ctx, st, filepath.Join(dir, "archive"), dir)
	if err != nil {
		t.Fatalf("one bad file aborted the whole walk: %v", err)
	}
	if res.Inserted != 2 {
		t.Errorf("inserted %d, want both valid sessions: %+v", res.Inserted, res)
	}
	if len(res.FailedSessions) != 1 {
		t.Fatalf("failed sessions = %v, want the one unreadable file", res.FailedSessions)
	}
	if !strings.HasSuffix(res.FailedSessions[0], "b-broken.jsonl") {
		t.Errorf("failed session path = %q", res.FailedSessions[0])
	}
}

func TestImportClaudeCodeAbortsOnOperationalFailure(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	dir := t.TempDir()
	line := `{"type":"user","uuid":"u-1","timestamp":"2026-08-17T10:00:00.000Z",` +
		`"message":{"role":"user","content":"hello"}}`
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A cancelled context is an operational failure: it says nothing about the
	// transcript, so it must not be filed as a per-file parse failure.
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	res, err := ImportClaudeCode(cancelled, st, filepath.Join(dir, "archive"), dir)
	if err == nil {
		t.Fatal("a cancelled import should surface")
	}
	if len(res.FailedSessions) != 0 {
		t.Errorf("an operational failure was recorded as a bad session: %v", res.FailedSessions)
	}
}
