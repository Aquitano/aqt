package disk

import (
	"os"

	"golang.org/x/sys/unix"
)

// Move renames a file or folder within one file system and fails when to
// exists.
func Move(from, to string) error {
	if err := unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE); err != nil {
		return &os.LinkError{Op: "move", Old: from, New: to, Err: err}
	}
	return nil
}
