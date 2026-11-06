//go:build windows

package disk

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
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

func TestLookupFoldKeepsDirectoryLastAccess(t *testing.T) {
	root := t.TempDir()
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, name := range []string{"present", "absent", "control"} {
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if name != "absent" {
			if err := os.WriteFile(filepath.Join(dir, ".ATTIC.TOML"), []byte("policy"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
		if name == "control" {
			if _, err := os.ReadDir(dir); err != nil {
				t.Fatal(err)
			}
			continue
		}
		entries, err := LookupFold(dir, ".attic.toml")
		want := 0
		if name == "present" {
			want = 1
		}
		if err != nil || len(entries) != want {
			t.Fatalf("%s lookup: %+v, %v", name, entries, err)
		}
		if want == 1 && entries[0].Name != ".ATTIC.TOML" {
			t.Fatalf("lookup lost stored filename spelling: %+v", entries)
		}
	}
	control, err := Stat(filepath.Join(root, "control"))
	if err != nil {
		t.Fatal(err)
	}
	if control.Accessed.Equal(old) {
		t.Skip("this volume does not update directory last-access times")
	}
	for _, name := range []string{"present", "absent"} {
		e, err := Stat(filepath.Join(root, name))
		if err != nil || !e.Accessed.Equal(old) {
			t.Errorf("%s lookup moved directory last access to %s: %v", name, e.Accessed, err)
		}
	}
}

func TestHoldKeepsWritersOutAndRestoresAccessTime(t *testing.T) {
	path := filepath.Join(t.TempDir(), "video.mp4")
	if err := os.WriteFile(path, []byte("frames"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := Hold(path)
	if err != nil {
		t.Fatal(err)
	}
	if w, err := os.OpenFile(path, os.O_WRONLY, 0); err == nil {
		w.Close()
		t.Fatal("a writer opened a held file")
	}
	// What another program's read does: the access time moves, the change time stays.
	other, err := openShared(path, windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, 0)
	if err != nil {
		t.Fatal(err)
	}
	read := fileBasicInfo{LastAccessTime: f.times.LastAccessTime + int64(48*time.Hour/100), ChangeTime: f.times.ChangeTime}
	err = windows.SetFileInformationByHandle(other, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&read)), uint32(unsafe.Sizeof(read)))
	windows.CloseHandle(other)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Restore(); err != nil {
		t.Fatal(err)
	}
	var now fileBasicInfo
	if err := basicInfo(windows.Handle(f.Fd()), &now); err != nil {
		t.Fatal(err)
	}
	if now.LastAccessTime != f.times.LastAccessTime || now.ChangeTime != f.times.ChangeTime {
		t.Errorf("times after restore = %+v, want %+v", now, f.times)
	}
	f.Close()

	w, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := Hold(path); !errors.Is(err, ErrInUse) {
		t.Fatalf("Hold while a writer has it open = %v, want ErrInUse", err)
	}
}
