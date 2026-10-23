package disk

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"lukechampine.com/blake3"
)

func TestHashOrdinaryAllowsOnlyTheVolumeMountRoot(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, []byte("bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	volume, _, err := Locate(root)
	if err != nil {
		t.Fatal(err)
	}
	p, err := windows.UTF16PtrFromString(volume.Root)
	if err != nil {
		t.Fatal(err)
	}
	var name [windows.MAX_PATH + 1]uint16
	if err := windows.GetVolumeNameForVolumeMountPoint(p, &name[0], uint32(len(name))); err != nil {
		t.Fatal(err)
	}
	mount := filepath.Join(t.TempDir(), "mount")
	makeMountPoint(t, mount, `\??\`+strings.TrimPrefix(windows.UTF16ToString(name[:]), `\\?\`))
	rel, err := filepath.Rel(volume.Root, file)
	if err != nil {
		t.Fatal(err)
	}
	digest, n, err := HashOrdinary(t.Context(), mount, rel)
	if err != nil || digest != blake3.Sum256([]byte("bytes")) || n != 5 {
		t.Fatalf("mounted root: %x, %d, %v", digest, n, err)
	}
	if _, _, err := HashOrdinary(t.Context(), filepath.Dir(mount), filepath.Join("mount", rel)); !errors.Is(err, ErrNotOrdinary) {
		t.Fatalf("followed a mount below the root: %v", err)
	}
	junction := filepath.Join(t.TempDir(), "junction")
	makeMountPoint(t, junction, `\??\`+root)
	if _, _, err := HashOrdinary(t.Context(), junction, "file"); !errors.Is(err, ErrNotOrdinary) {
		t.Fatalf("accepted a directory junction as a volume root: %v", err)
	}
}

func makeMountPoint(t *testing.T, link, target string) {
	t.Helper()
	if err := os.Mkdir(link, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil {
			t.Error(err)
		}
	})
	p, err := windows.UTF16PtrFromString(link)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	name, err := windows.UTF16FromString(target)
	if err != nil {
		t.Fatal(err)
	}
	// Mount-point reparse data has an 8-byte header, four 16-bit name fields,
	// then the substitute name and an empty print name, both NUL-terminated.
	data := make([]byte, 16+len(name)*2+2)
	binary.LittleEndian.PutUint32(data, windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(data[4:], uint16(len(data)-8))
	binary.LittleEndian.PutUint16(data[10:], uint16((len(name)-1)*2))
	binary.LittleEndian.PutUint16(data[12:], uint16(len(name)*2))
	for i, c := range name {
		binary.LittleEndian.PutUint16(data[16+i*2:], c)
	}
	var returned uint32
	if err := windows.DeviceIoControl(h, windows.FSCTL_SET_REPARSE_POINT, &data[0], uint32(len(data)), nil, 0, &returned, nil); err != nil {
		t.Fatal(err)
	}
}
