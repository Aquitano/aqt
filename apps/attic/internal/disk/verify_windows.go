package disk

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func openOrdinary(root, rel string) (*os.File, error) {
	parts := append([]string{root}, strings.Split(rel, string(filepath.Separator))...)
	var held []windows.Handle
	defer func() {
		for _, h := range held {
			windows.CloseHandle(h)
		}
	}()
	path := ""
	for i, part := range parts {
		path = filepath.Join(path, part)
		p, err := windows.UTF16PtrFromString(longPath(path))
		if err != nil {
			return nil, err
		}
		access := uint32(windows.FILE_READ_ATTRIBUTES)
		if i == len(parts)-1 {
			access |= windows.FILE_READ_DATA
		}
		// Holding ancestors without delete sharing prevents junction replacement
		// between checking their attributes and opening the file.
		h, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
			windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL|
				windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
		if err != nil {
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		held = append(held, h)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(h, &info); err != nil {
			return nil, err
		}
		if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|remoteAttributes) != 0 ||
			(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != (i < len(parts)-1) {
			return nil, ErrNotOrdinary
		}
		if i == len(parts)-1 {
			// Suppress access-time updates when the source grants attribute access,
			// as Open does; write-protected media can still be verified.
			kept, err := windows.CreateFile(p, access|windows.FILE_WRITE_ATTRIBUTES,
				windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
				windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
			if err == nil {
				keep := windows.Filetime{LowDateTime: 0xFFFFFFFF, HighDateTime: 0xFFFFFFFF}
				if windows.SetFileTime(kept, nil, &keep, nil) == nil {
					windows.CloseHandle(h)
					held[len(held)-1] = kept
				} else {
					windows.CloseHandle(kept)
				}
			}
		}
	}
	h := held[len(held)-1]
	held = held[:len(held)-1]
	return os.NewFile(uintptr(h), path), nil
}
