package disk

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOpenOrdinaryRefusesOfflineFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "placeholder")
	if err := os.WriteFile(path, []byte("local fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_OFFLINE); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_NORMAL) })
	if f, err := OpenOrdinary(root, "placeholder"); err == nil {
		f.Close()
		t.Fatal("opened offline source")
	}
}
