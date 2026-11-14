//go:build unix && !linux

package disk

import "os"

// Move renames a file within one file system and fails when to exists. A
// hard link refuses an occupied path where a rename would replace it, so
// folders cannot move here.
func Move(from, to string) error {
	if err := os.Link(from, to); err != nil {
		return err
	}
	return os.Remove(from)
}
