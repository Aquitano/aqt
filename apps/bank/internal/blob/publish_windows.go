package blob

import (
	"os"

	"golang.org/x/sys/windows"
)

func makeFanOut(dir string) error {
	return os.MkdirAll(dir, 0o700)
}

// Windows cannot sync a directory handle; MOVEFILE_WRITE_THROUGH returns only
// once the rename is on disk.
func publish(oldPath, newPath string) error {
	from, err := windows.UTF16PtrFromString(oldPath)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(newPath)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
