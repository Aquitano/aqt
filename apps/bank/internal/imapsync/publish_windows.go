package imapsync

import "golang.org/x/sys/windows"

func publishMessage(oldPath, newPath string) error {
	return moveWriteThrough(oldPath, newPath, windows.MOVEFILE_REPLACE_EXISTING)
}

func publishBatch(dir string) error {
	return moveWriteThrough(dir, dir+"-ready", 0)
}

func moveWriteThrough(oldPath, newPath string, flags uint32) error {
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
