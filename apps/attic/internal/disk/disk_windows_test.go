//go:build windows

package disk

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"lukechampine.com/blake3"
)

func TestForwardSlashPaths(t *testing.T) {
	dir := t.TempDir()
	body := []byte("backup bytes")
	path := filepath.Join(dir, "backup.bin")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := List(filepath.ToSlash(dir))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name != "backup.bin" {
		t.Fatalf("List = %+v", entries)
	}
	path = filepath.ToSlash(path)
	digest, n, err := Hash(context.Background(), path)
	if err != nil || n != int64(len(body)) || digest != blake3.Sum256(body) {
		t.Fatalf("Hash = %x, %d, %v", digest, n, err)
	}
	entry, err := Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Name != "backup.bin" || entry.Size != int64(len(body)) {
		t.Fatalf("Stat = %+v", entry)
	}
}

func TestLongPath(t *testing.T) {
	for _, tt := range []struct{ path, want string }{
		{`C:/backup/file.bin`, `\\?\C:\backup\file.bin`},
		{`//server/share/backup/file.bin`, `\\?\UNC\server\share\backup\file.bin`},
		{`\\?\UNC\server\share\file.bin`, `\\?\UNC\server\share\file.bin`},
	} {
		t.Run(tt.path, func(t *testing.T) {
			if got := longPath(tt.path); got != tt.want {
				t.Fatalf("longPath(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestHashKeepsLastAccess(t *testing.T) {
	dir := t.TempDir()
	body := []byte("backup bytes")
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, name := range []string{"hashed.bin", "read.bin"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}

	digest, n, err := Hash(context.Background(), filepath.Join(dir, "hashed.bin"))
	if err != nil || n != int64(len(body)) || digest != blake3.Sum256(body) {
		t.Fatalf("Hash = %x, %d, %v", digest, n, err)
	}
	if _, err := os.ReadFile(filepath.Join(dir, "read.bin")); err != nil {
		t.Fatal(err)
	}

	entries, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	accessed := map[string]time.Time{}
	for _, e := range entries {
		if e.FileID == 0 {
			t.Errorf("%s has no file id", e.Name)
		}
		accessed[e.Name] = e.Accessed
	}
	if accessed["read.bin"].Equal(old) {
		t.Skip("this volume does not update last-access times, so there is nothing to preserve")
	}
	if !accessed["hashed.bin"].Equal(old) {
		t.Errorf("hashing moved last access from %s to %s", old, accessed["hashed.bin"])
	}
}
