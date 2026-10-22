package disk

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenOrdinaryRejectsLinksAndDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "source"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"dir", "../outside"} {
		if f, err := OpenOrdinary(root, rel); err == nil {
			f.Close()
			t.Fatalf("accepted %s", rel)
		}
	}
	if err := os.Symlink(filepath.Join(root, "dir"), filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if f, err := OpenOrdinary(root, filepath.Join("link", "source")); err == nil {
		f.Close()
		t.Fatal("followed directory link")
	}
	if err := os.Symlink(filepath.Join(root, "dir", "source"), filepath.Join(root, "filelink")); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenOrdinary(root, "filelink"); err == nil {
		f.Close()
		t.Fatal("followed file link")
	}
}
