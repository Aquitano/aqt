package retrieve

import (
	"strings"

	"golang.org/x/sys/windows"
)

func publish(source, destination string) error {
	from, err := windows.UTF16PtrFromString(publicationPath(source))
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(publicationPath(destination))
	if err != nil {
		return err
	}
	// No REPLACE_EXISTING or COPY_ALLOWED: a race cannot overwrite or copy.
	return windows.MoveFileEx(from, to, 0)
}

func publicationPath(path string) string {
	if strings.HasPrefix(path, `\\?\`) {
		return path
	}
	if strings.HasPrefix(path, `\\`) {
		return `\\?\UNC\` + path[2:]
	}
	return `\\?\` + path
}
