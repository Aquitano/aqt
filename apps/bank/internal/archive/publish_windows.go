package archive

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

func makeArchiveDirectories(path string) error {
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return nil
	}
	parent := filepath.Dir(path)
	if parent == path {
		return &os.PathError{Op: "mkdir", Path: path, Err: os.ErrNotExist}
	}
	if err := makeArchiveDirectories(parent); err != nil {
		return err
	}
	temporary, err := os.MkdirTemp(parent, ".partial-dir-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	if err := moveArchiveFile(temporary, path, 0); err != nil {
		if info, statErr := os.Stat(path); statErr == nil && info.IsDir() && (errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_ACCESS_DENIED)) {
			return nil
		}
		return err
	}
	return nil
}

func publishArchiveFile(oldPath, newPath string) error {
	err := moveArchiveFile(oldPath, newPath, 0)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) || errors.Is(err, windows.ERROR_ACCESS_DENIED) || errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		if info, statErr := os.Stat(newPath); statErr == nil && info.Mode().IsRegular() {
			return syncArchiveFile(newPath)
		}
	}
	return err
}

// os.OpenFile omits FILE_SHARE_DELETE, so it fails with a sharing violation
// while another writer's MoveFileEx still holds the just-published file.
func syncArchiveFile(path string) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: path, Err: err}
	}
	return errors.Join(windows.FlushFileBuffers(handle), windows.CloseHandle(handle))
}

func moveArchiveFile(oldPath, newPath string, flags uint32) error {
	oldName, err := windows.UTF16PtrFromString(oldPath)
	if err != nil {
		return err
	}
	newName, err := windows.UTF16PtrFromString(newPath)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(oldName, newName, flags|windows.MOVEFILE_WRITE_THROUGH)
}
