package archive

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestListOrdersOldestFirstAndSkipsDebris(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "chatgpt")
	if err := os.MkdirAll(filepath.Join(dir, "subdir"), 0o700); err != nil {
		t.Fatal(err)
	}
	newer, err := Write(root, "chatgpt", "aaaaaaaaaaaa-conversations.json", []byte("new"))
	if err != nil {
		t.Fatal(err)
	}
	older, err := Write(root, "chatgpt", "bbbbbbbbbbbb-export.zip", []byte("old"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".partial-x"), []byte("junk"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The zip arrived first; mtime, not name, decides replay order.
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(root, older), past, past); err != nil {
		t.Fatal(err)
	}

	entries, err := List(root, "chatgpt")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the two archived inputs", entries)
	}
	if entries[0].Ref != older || entries[1].Ref != newer {
		t.Errorf("order = %q, %q; want oldest first", entries[0].Ref, entries[1].Ref)
	}
	if entries[0].Name != "export.zip" || entries[1].Name != "conversations.json" {
		t.Errorf("names = %q, %q; want the hash prefixes stripped", entries[0].Name, entries[1].Name)
	}
}

func TestListNeverArchivedSourceIsEmpty(t *testing.T) {
	entries, err := List(t.TempDir(), "chatgpt")
	if err != nil || len(entries) != 0 {
		t.Fatalf("entries, err = %v, %v; want none and no error", entries, err)
	}
}

func TestStageRestoresOriginalName(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(t.TempDir(), "session-1.jsonl")
	if err := os.WriteFile(src, []byte(`{"type":"user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Copy(root, "sample", src); err != nil {
		t.Fatal(err)
	}
	entries, err := List(root, "sample")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries, err = %v, %v", entries, err)
	}

	staged, err := Stage(root, entries[0], t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(staged) != "session-1.jsonl" {
		t.Errorf("staged as %q, want the original filename back", staged)
	}
	got, err := os.ReadFile(staged)
	if err != nil || string(got) != `{"type":"user"}` {
		t.Errorf("content, err = %q, %v", got, err)
	}

	// Re-archiving the staged copy must dedup onto the existing reference,
	// not add a second file: this is what keeps a replay from growing the
	// archive.
	ref, err := Copy(root, "sample", staged)
	if err != nil {
		t.Fatal(err)
	}
	if ref != entries[0].Ref {
		t.Errorf("re-archive ref = %q, want %q", ref, entries[0].Ref)
	}
}

func TestStageKeepsUnprefixedNames(t *testing.T) {
	root := t.TempDir()
	// Write-created names (a merged-shard array aside, e.g. json stdin drops)
	// carry no hash prefix; the name must pass through untouched.
	if _, err := Write(root, "json", "stdin-abc123.json", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	entries, err := List(root, "json")
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries, err = %v, %v", entries, err)
	}
	if entries[0].Name != "stdin-abc123.json" {
		t.Errorf("name = %q, want it unmodified", entries[0].Name)
	}
}
