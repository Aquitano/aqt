package scratch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTempCleanupKeepsActiveAndUnownedFiles(t *testing.T) {
	base := t.TempDir()
	unrelated := filepath.Join(base, "attic-123.zip")
	if err := os.WriteFile(unrelated, []byte("user archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	active, err := New(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer active.Close()
	stale, err := New(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := stale.lock.Close(); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	for _, p := range []string{unrelated, active.Path, stale.Path} {
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Dir(active.Path)
	unowned := filepath.Join(root, "scan-123")
	if err := os.Mkdir(unowned, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(unowned, old, old); err != nil {
		t.Fatal(err)
	}
	if err := removeStaleWorkspaces(root); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{unrelated, active.Path, unowned} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("cleanup removed %s: %v", p, err)
		}
	}
	if _, err := os.Stat(stale.Path); !os.IsNotExist(err) {
		t.Errorf("abandoned workspace remains: %v", err)
	}
	if err := active.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(active.Path); !os.IsNotExist(err) {
		t.Errorf("finished workspace remains: %v", err)
	}
}
