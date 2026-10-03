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
