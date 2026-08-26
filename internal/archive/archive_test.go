package archive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteRejectsUnsafeSource(t *testing.T) {
	root := t.TempDir()
	for _, source := range []string{
		"", "..", "../sibling", "a/b", "/etc", ".hidden", "a\x00b", "..\\windows",
	} {
		if _, err := Write(root, source, "x.eml", []byte("hi")); err == nil {
			t.Errorf("source %q was accepted", source)
		}
	}
	// Nothing may exist outside the archive root, whatever was attempted.
	sibling := filepath.Join(filepath.Dir(root), "sibling")
	if _, err := os.Stat(sibling); err == nil {
		t.Fatalf("%s was created", sibling)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("archive root is not empty: %v", entries)
	}
}

func TestWriteAcceptsOrdinarySources(t *testing.T) {
	root := t.TempDir()
	for _, source := range []string{"gmail", "proton", "agent-notes", "notes_2024", "a.b"} {
		rel, err := Write(root, source, "one.eml", []byte("hi"))
		if err != nil {
			t.Fatalf("source %q: %v", source, err)
		}
		if !strings.HasPrefix(rel, source+string(filepath.Separator)) {
			t.Errorf("ref %q does not live under %q", rel, source)
		}
		if _, err := os.Stat(filepath.Join(root, rel)); err != nil {
			t.Errorf("source %q: %v", source, err)
		}
	}
}

func TestReplaceSupersedes(t *testing.T) {
	dir := t.TempDir()
	ref, err := Replace(dir, "codex", "s.jsonl", []byte("v1"))
	if err != nil {
		t.Fatal(err)
	}
	if !Identical(dir, "codex", "s.jsonl", []byte("v1")) {
		t.Fatal("archived content not identical to what was written")
	}
	ref2, err := Replace(dir, "codex", "s.jsonl", []byte("v1 grown"))
	if err != nil {
		t.Fatal(err)
	}
	if ref2 != ref {
		t.Fatalf("replacing must keep the reference stable: %q vs %q", ref2, ref)
	}
	if Identical(dir, "codex", "s.jsonl", []byte("v1")) {
		t.Fatal("old content still reported as archived after replace")
	}
	entries, err := os.ReadDir(filepath.Join(dir, "codex"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("replace accumulated %d files, want exactly one", len(entries))
	}
	got, err := os.ReadFile(filepath.Join(dir, ref))
	if err != nil || string(got) != "v1 grown" {
		t.Fatalf("archived content = %q, %v", got, err)
	}
}
