package disk

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func openOrdinary(root, rel string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(strings.TrimRight(longPath(root), `\`) + `\`)
	if err != nil {
		return nil, err
	}
	// Mounted folders are reparse points. Walking from the volume GUID lets
	// the root work while keeping the reparse checks on every path below it.
	var volumeName [windows.MAX_PATH + 1]uint16
	if windows.GetVolumeNameForVolumeMountPoint(p, &volumeName[0], uint32(len(volumeName))) == nil {
		root = windows.UTF16ToString(volumeName[:])
	}
	parts := append([]string{root}, strings.Split(rel, string(filepath.Separator))...)
	var held []windows.Handle
	defer func() {
		for _, h := range held {
			windows.CloseHandle(h)
		}
	}()
	path := ""
	var parent windows.Handle
	for i, part := range parts {
		path = filepath.Join(path, part)
		file := i == len(parts)-1
		h, err := openOrdinaryHandle(parent, part, file)
		if err != nil {
			return nil, &os.PathError{Op: "open", Path: path, Err: err}
		}
		held = append(held, h)
		parent = h
	}
	h := held[len(held)-1]
	held = held[:len(held)-1]
	return os.NewFile(uintptr(h), path), nil
}

func openOrdinaryHandle(parent windows.Handle, name string, file bool) (windows.Handle, error) {
	access := uint32(windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	if file {
		access |= windows.FILE_READ_DATA | windows.FILE_WRITE_ATTRIBUTES
	}
	h, err := openVerificationHandle(parent, name, access)
	if err != nil && file {
		h, err = openVerificationHandle(parent, name, access&^windows.FILE_WRITE_ATTRIBUTES)
	}
	if err != nil {
		return windows.InvalidHandle, err
	}
	var info windows.ByHandleFileInformation
	err = windows.GetFileInformationByHandle(h, &info)
	if err == nil && (info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|remoteAttributes) != 0 ||
		(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) == file) {
		err = ErrNotOrdinary
	}
	if err != nil {
		windows.CloseHandle(h)
		return windows.InvalidHandle, err
	}
	if file {
		// Suppress access-time updates when permitted; write-protected media
		// can still be verified through the read-only fallback above.
		keep := windows.Filetime{LowDateTime: 0xFFFFFFFF, HighDateTime: 0xFFFFFFFF}
		_ = windows.SetFileTime(h, nil, &keep, nil)
	}
	return h, nil
}

func openVerificationHandle(parent windows.Handle, name string, access uint32) (windows.Handle, error) {
	const share = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE
	if parent == 0 {
		p, err := windows.UTF16PtrFromString(longPath(name))
		if err != nil {
			return windows.InvalidHandle, err
		}
		return windows.CreateFile(p, access, share, nil, windows.OPEN_EXISTING,
			windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_OPEN_NO_RECALL|
				windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	}
	objectName, err := windows.NewNTUnicodeString(name)
	if err != nil {
		return windows.InvalidHandle, err
	}
	// Absolute paths can follow an ancestor changed into a junction even while
	// its handle is held. Resolve each child through that verified handle.
	attrs := windows.OBJECT_ATTRIBUTES{
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var h windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&h, access, &attrs, &status, nil, 0, share, windows.FILE_OPEN,
		windows.FILE_SYNCHRONOUS_IO_NONALERT|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_NO_RECALL|
			windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SEQUENTIAL_ONLY, 0, 0)
	if errors.Is(err, windows.STATUS_REPARSE_POINT_ENCOUNTERED) || errors.Is(err, windows.STATUS_REPARSE_POINT_NOT_RESOLVED) {
		return windows.InvalidHandle, ErrNotOrdinary
	}
	var ntStatus windows.NTStatus
	if errors.As(err, &ntStatus) {
		return windows.InvalidHandle, ntStatus.Errno()
	}
	return h, err
}
