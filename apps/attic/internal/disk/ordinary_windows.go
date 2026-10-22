//go:build windows

package disk

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// OpenOrdinary pins each directory until the file is open, refusing reparse
// points and remote placeholders before any source bytes can be read.
func OpenOrdinary(root, rel string) (*os.File, error) {
	if !filepath.IsLocal(rel) {
		return nil, errors.New("non-local source path")
	}
	var parents []windows.Handle
	defer func() {
		for _, h := range parents {
			windows.CloseHandle(h)
		}
	}()
	parts := append([]string{""}, strings.Split(filepath.Clean(rel), string(filepath.Separator))...)
	path := root
	for i, part := range parts {
		path = filepath.Join(path, part)
		p, err := windows.UTF16PtrFromString(longPath(path))
		if err != nil {
			return nil, err
		}
		access := uint32(windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
		if i == len(parts)-1 {
			access |= windows.FILE_READ_DATA
		}
		flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT | windows.FILE_FLAG_BACKUP_SEMANTICS | windows.FILE_FLAG_OPEN_NO_RECALL)
		// Denying delete sharing prevents a checked ancestor being replaced.
		h, err := windows.CreateFile(p, access|windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
		if err == nil {
			keep := windows.Filetime{LowDateTime: 0xFFFFFFFF, HighDateTime: 0xFFFFFFFF}
			if windows.SetFileTime(h, nil, &keep, nil) != nil {
				windows.CloseHandle(h)
				h = windows.InvalidHandle
			}
		}
		if err != nil || h == windows.InvalidHandle {
			h, err = windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
		}
		if err != nil {
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		var info windows.ByHandleFileInformation
		err = windows.GetFileInformationByHandle(h, &info)
		if err == nil && info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|remoteAttributes) != 0 {
			err = errors.New("source is a link or remote placeholder")
		}
		isDir := info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
		if err == nil && isDir != (i < len(parts)-1) {
			err = errors.New("source is not an ordinary file path")
		}
		if err != nil {
			windows.CloseHandle(h)
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		if i == len(parts)-1 {
			return os.NewFile(uintptr(h), path), nil
		}
		parents = append(parents, h)
	}
	return nil, errors.New("empty source path")
}
