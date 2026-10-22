package verify

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
	"golang.org/x/sys/windows"
	"lukechampine.com/blake3"
)

func TestLockedAndOfflineFilesAreNotVerified(t *testing.T) {
	m := testMount(t)
	path := filepath.Join(m.Root, "file")
	if err := os.WriteFile(path, []byte("bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := blake3.Sum256([]byte("bytes"))
	f := store.VerifyFile{Path: "/file", Kind: "file", HashState: "done", Digest: digest[:]}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	r := readOne(t.Context(), m, f)
	windows.CloseHandle(h)
	if r.Status != "unreadable" || r.Bytes != 0 {
		t.Fatalf("locked: %+v", r)
	}
	if err := windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_OFFLINE); err != nil {
		t.Fatal(err)
	}
	defer windows.SetFileAttributes(p, windows.FILE_ATTRIBUTE_NORMAL)
	r = readOne(t.Context(), m, f)
	if r.Status != "unavailable" || r.Bytes != 0 {
		t.Fatalf("offline: %+v", r)
	}
}
