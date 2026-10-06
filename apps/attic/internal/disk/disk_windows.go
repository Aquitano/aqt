//go:build windows

package disk

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Layouts x/sys/windows does not declare. fileIDBothDirInfo mirrors Go's own
// internal/syscall/windows copy: ShortNameLength is a CCHAR in the SDK, and
// declaring it uint32 keeps FileID and FileName at the SDK offsets (96, 104).
type fileIDBothDirInfo struct {
	NextEntryOffset uint32
	FileIndex       uint32
	CreationTime    int64
	LastAccessTime  int64
	LastWriteTime   int64
	ChangeTime      int64
	EndOfFile       int64
	AllocationSize  int64
	FileAttributes  uint32
	FileNameLength  uint32
	EaSize          uint32
	ShortNameLength uint32
	ShortName       [12]uint16
	FileID          uint64
	FileName        [1]uint16
}

type fileFullDirInfo struct {
	NextEntryOffset uint32
	FileIndex       uint32
	CreationTime    int64
	LastAccessTime  int64
	LastWriteTime   int64
	ChangeTime      int64
	EndOfFile       int64
	AllocationSize  int64
	FileAttributes  uint32
	FileNameLength  uint32
	EaSize          uint32
	FileName        [1]uint16
}

type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

type fileIDInfo struct {
	VolumeSerialNumber uint64
	FileID             [16]byte
}

type partitionInformationEx struct {
	PartitionStyle     uint32
	_                  uint32
	StartingOffset     int64
	PartitionLength    int64
	PartitionNumber    uint32
	RewritePartition   byte
	IsServicePartition byte
	_                  [2]byte
	// A PARTITION_INFORMATION_MBR or PARTITION_INFORMATION_GPT union.
	Info [112]byte
}

type storagePropertyQuery struct {
	PropertyID uint32
	QueryType  uint32
	Additional [4]byte
}

const (
	ioctlDiskGetPartitionInfoEx = 0x00070048
	ioctlStorageQueryProperty   = 0x002D1400
	partitionStyleGPT           = 1
	// GetFinalPathNameByHandle flags: FILE_NAME_NORMALIZED | VOLUME_NAME_DOS.
	fileNameNormalizedDOS = 0

	// Placeholders whose bytes live elsewhere. Reading them downloads the
	// file, so they are recorded and never hashed.
	remoteAttributes = windows.FILE_ATTRIBUTE_OFFLINE | 0x00040000 | 0x00400000
)

// open returns a handle on which reading does not move the last-access time.
// SetFileTime with -1 tells Windows to stop updating it for this handle, which
// needs attribute-write access. Write-protected media refuses that access, and
// the open falls back to a plain one there.
func open(path string, access, flags uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(longPath(path))
	if err != nil {
		return windows.InvalidHandle, err
	}
	share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
	h, err := windows.CreateFile(p, access|windows.FILE_WRITE_ATTRIBUTES, share, nil, windows.OPEN_EXISTING, flags, 0)
	if err == nil {
		keep := windows.Filetime{LowDateTime: 0xFFFFFFFF, HighDateTime: 0xFFFFFFFF}
		if windows.SetFileTime(h, nil, &keep, nil) == nil {
			return h, nil
		}
		windows.CloseHandle(h)
	}
	return windows.CreateFile(p, access, share, nil, windows.OPEN_EXISTING, flags, 0)
}

// longPath lifts the MAX_PATH limit; backup trees nest deeper than 260
// characters routinely.
func longPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:]
	}
	return `\\?\` + path
}

func Open(path string) (*os.File, error) {
	h, err := open(path, windows.FILE_READ_DATA|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_FLAG_SEQUENTIAL_SCAN)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// List reads a directory with GetFileInformationByHandleEx, which returns
// names, sizes, times, attributes and file ids for many entries per call
// without opening any of them. File systems that cannot report ids get the
// same listing without them.
func List(dir string) ([]Entry, error) {
	h, err := open(dir, windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_FLAG_BACKUP_SEMANTICS)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: dir, Err: err}
	}
	defer windows.CloseHandle(h)

	buf := make([]byte, 64<<10)
	withIDs := true
	class := uint32(windows.FileIdBothDirectoryRestartInfo)
	var out []Entry
	for {
		err := windows.GetFileInformationByHandleEx(h, class, &buf[0], uint32(len(buf)))
		if err != nil {
			restart := class == windows.FileIdBothDirectoryRestartInfo || class == windows.FileFullDirectoryRestartInfo
			switch {
			case errors.Is(err, windows.ERROR_NO_MORE_FILES):
				return out, nil
			case restart && withIDs && (errors.Is(err, windows.ERROR_INVALID_PARAMETER) ||
				errors.Is(err, windows.ERROR_NOT_SUPPORTED) || errors.Is(err, windows.ERROR_INVALID_FUNCTION)):
				withIDs = false
				class = windows.FileFullDirectoryRestartInfo
				continue
			case restart && errors.Is(err, windows.ERROR_FILE_NOT_FOUND):
				// An empty root directory has no "." or ".." to return.
				return out, nil
			}
			return out, &os.PathError{Op: "list", Path: dir, Err: err}
		}
		if withIDs {
			class = windows.FileIdBothDirectoryInfo
		} else {
			class = windows.FileFullDirectoryInfo
		}
		for off := 0; ; {
			var e Entry
			var next uint32
			if withIDs {
				info := (*fileIDBothDirInfo)(unsafe.Pointer(&buf[off]))
				next = info.NextEntryOffset
				e = entry(unsafe.Slice(&info.FileName[0], info.FileNameLength/2), info.FileAttributes, info.EndOfFile,
					info.CreationTime, info.LastWriteTime, info.LastAccessTime, info.ChangeTime)
				e.FileID = info.FileID
			} else {
				info := (*fileFullDirInfo)(unsafe.Pointer(&buf[off]))
				next = info.NextEntryOffset
				e = entry(unsafe.Slice(&info.FileName[0], info.FileNameLength/2), info.FileAttributes, info.EndOfFile,
					info.CreationTime, info.LastWriteTime, info.LastAccessTime, info.ChangeTime)
			}
			if e.Name != "." && e.Name != ".." {
				out = append(out, e)
			}
			if next == 0 {
				break
			}
			off += int(next)
		}
	}
}

func entry(name []uint16, attrs uint32, size, created, modified, accessed, changed int64) Entry {
	e := Entry{
		Name:       windows.UTF16ToString(name),
		Dir:        attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		Link:       attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0,
		Remote:     attrs&remoteAttributes != 0,
		Created:    fileTime(created),
		Modified:   fileTime(modified),
		Accessed:   fileTime(accessed),
		Changed:    fileTime(changed),
		Attributes: attrs,
	}
	if !e.Dir {
		e.Size = size
	}
	return e
}

func fileTime(ft int64) time.Time {
	if ft <= 0 {
		return time.Time{}
	}
	t := windows.Filetime{LowDateTime: uint32(ft), HighDateTime: uint32(ft >> 32)}
	return time.Unix(0, t.Nanoseconds()).UTC()
}

// Stat describes one path the way List describes a directory's entries. The
// scan uses it for the folders above the one it was asked to scan. It follows
// reparse points: Locate already resolved the path, so the only one left is a
// volume mounted in a folder, and the scan wants that volume's own root.
func Stat(path string) (Entry, error) {
	h, err := open(path, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_FLAG_BACKUP_SEMANTICS)
	if err != nil {
		return Entry{}, &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer windows.CloseHandle(h)
	var bh windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bh); err != nil {
		return Entry{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	var basic fileBasicInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return Entry{}, &os.PathError{Op: "stat", Path: path, Err: err}
	}
	e := entry(nil, bh.FileAttributes, int64(bh.FileSizeHigh)<<32|int64(bh.FileSizeLow),
		basic.CreationTime, basic.LastWriteTime, basic.LastAccessTime, basic.ChangeTime)
	e.Name = filepath.Base(path)
	e.FileID = uint64(bh.FileIndexHigh)<<32 | uint64(bh.FileIndexLow)
	return e, nil
}

// Locate resolves path to its volume and to the path's components below the
// volume root, spelled as the file system stores them.
func Locate(path string) (Volume, []string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Volume{}, nil, err
	}
	if abs, err = finalPath(abs); err != nil {
		return Volume{}, nil, err
	}
	p16, err := windows.UTF16PtrFromString(abs)
	if err != nil {
		return Volume{}, nil, err
	}
	buf := make([]uint16, 1024)
	if err := windows.GetVolumePathName(p16, &buf[0], uint32(len(buf))); err != nil {
		return Volume{}, nil, fmt.Errorf("volume of %s: %w", abs, err)
	}
	root := windows.UTF16ToString(buf)
	fp, err := fingerprint(root)
	if err != nil {
		return Volume{}, nil, err
	}
	rel := ""
	if len(abs) > len(root) && strings.EqualFold(abs[:len(root)], root) {
		rel = abs[len(root):]
	}
	parts := strings.FieldsFunc(rel, func(r rune) bool { return r == '\\' || r == '/' })
	return Volume{Fingerprint: fp, Root: root}, parts, nil
}

// finalPath spells path as the file system stores it, so "e:\files" becomes
// `E:\Files`. Stored paths keep the real case of every folder above the scan.
func finalPath(path string) (string, error) {
	h, err := open(path, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_FLAG_BACKUP_SEMANTICS)
	if err != nil {
		return "", &os.PathError{Op: "open", Path: path, Err: err}
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, 1024)
	for {
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), fileNameNormalizedDOS)
		if err != nil {
			return "", &os.PathError{Op: "resolve", Path: path, Err: err}
		}
		if int(n) < len(buf) {
			p := windows.UTF16ToString(buf[:n])
			if rest, ok := strings.CutPrefix(p, `\\?\UNC\`); ok {
				return `\\` + rest, nil
			}
			return strings.TrimPrefix(p, `\\?\`), nil
		}
		buf = make([]uint16, n+1)
	}
}

func fingerprint(root string) (Fingerprint, error) {
	r16, err := windows.UTF16PtrFromString(root)
	if err != nil {
		return Fingerprint{}, err
	}
	var label, fsName [windows.MAX_PATH + 1]uint16
	var serial32, maxComponent, flags uint32
	if err := windows.GetVolumeInformation(r16, &label[0], uint32(len(label)), &serial32, &maxComponent, &flags,
		&fsName[0], uint32(len(fsName))); err != nil {
		return Fingerprint{}, fmt.Errorf("volume information for %s: %w", root, err)
	}
	fp := Fingerprint{
		FS:     windows.UTF16ToString(fsName[:]),
		Label:  windows.UTF16ToString(label[:]),
		Serial: fmt.Sprintf("%08X", serial32),
	}
	fp.StableIDs = fp.FS == "NTFS" || fp.FS == "ReFS"
	if h, err := open(root, windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE, windows.FILE_FLAG_BACKUP_SEMANTICS); err == nil {
		var id fileIDInfo
		if windows.GetFileInformationByHandleEx(h, windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))) == nil &&
			id.VolumeSerialNumber>>32 != 0 {
			fp.Serial = fmt.Sprintf("%016X", id.VolumeSerialNumber)
		}
		windows.CloseHandle(h)
	}
	var total uint64
	if windows.GetDiskFreeSpaceEx(r16, nil, &total, nil) == nil {
		fp.Size = int64(total)
	}
	fp.PartitionID, fp.DeviceSerial = deviceIDs(r16)
	return fp, nil
}

// deviceIDs reads the partition GUID and the drive's serial number. Both are
// queried on a handle opened without access rights, which needs no
// administrator and never touches the volume's contents. Either may be empty:
// some USB bridges report no serial.
func deviceIDs(root *uint16) (partition, serial string) {
	name := make([]uint16, windows.MAX_PATH+1)
	if windows.GetVolumeNameForVolumeMountPoint(root, &name[0], uint32(len(name))) != nil {
		return "", ""
	}
	dev, err := windows.UTF16PtrFromString(strings.TrimSuffix(windows.UTF16ToString(name), `\`))
	if err != nil {
		return "", ""
	}
	h, err := windows.CreateFile(dev, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return "", ""
	}
	defer windows.CloseHandle(h)

	var part partitionInformationEx
	var n uint32
	if windows.DeviceIoControl(h, ioctlDiskGetPartitionInfoEx, nil, 0, (*byte)(unsafe.Pointer(&part)),
		uint32(unsafe.Sizeof(part)), &n, nil) == nil {
		var guid windows.GUID
		if part.PartitionStyle == partitionStyleGPT {
			guid = *(*windows.GUID)(unsafe.Pointer(&part.Info[16]))
		} else {
			guid = *(*windows.GUID)(unsafe.Pointer(&part.Info[8]))
		}
		if guid != (windows.GUID{}) {
			partition = guid.String()
		} else {
			partition = fmt.Sprintf("mbr@%d", part.StartingOffset)
		}
	}

	query := storagePropertyQuery{}
	desc := make([]byte, 1024)
	if windows.DeviceIoControl(h, ioctlStorageQueryProperty, (*byte)(unsafe.Pointer(&query)), uint32(unsafe.Sizeof(query)),
		&desc[0], uint32(len(desc)), &n, nil) == nil && n >= 28 {
		// STORAGE_DEVICE_DESCRIPTOR.SerialNumberOffset, an offset into the
		// descriptor of a NUL-terminated ASCII string, or 0 for none.
		off := int(*(*uint32)(unsafe.Pointer(&desc[24])))
		if off > 0 && off < int(n) {
			end := off
			for end < int(n) && desc[end] != 0 {
				end++
			}
			serial = strings.TrimSpace(string(desc[off:end]))
		}
	}
	return partition, serial
}

// Mounted lists the fixed and removable volumes attached right now, for
// marking search results online. Optical drives are skipped: an encrypted WD
// disk shows its unlock tool as one.
func Mounted() []Volume {
	n, err := windows.GetLogicalDriveStrings(0, nil)
	if err != nil || n == 0 {
		return nil
	}
	buf := make([]uint16, n)
	// A drive attached between the two calls makes the second report a larger
	// size and fill nothing; grow and ask again.
	for {
		if n, err = windows.GetLogicalDriveStrings(uint32(len(buf)), &buf[0]); err != nil {
			return nil
		}
		if int(n) <= len(buf) {
			break
		}
		buf = make([]uint16, n)
	}
	var out []Volume
	for start, i := 0, 0; i < int(n); i++ {
		if buf[i] != 0 {
			continue
		}
		root := windows.UTF16ToString(buf[start:i])
		start = i + 1
		if root == "" {
			continue
		}
		r16, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if t := windows.GetDriveType(r16); t != windows.DRIVE_FIXED && t != windows.DRIVE_REMOVABLE {
			continue
		}
		if fp, err := fingerprint(root); err == nil {
			out = append(out, Volume{Fingerprint: fp, Root: root})
		}
	}
	return out
}
