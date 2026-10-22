//go:build unix

package disk

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

func OpenOrdinary(root, rel string) (*os.File, error) {
	if !filepath.IsLocal(rel) {
		return nil, errors.New("non-local source path")
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(filepath.Clean(rel), string(filepath.Separator))
	for i, part := range parts {
		flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= unix.O_DIRECTORY
		}
		next, openErr := unix.Openat(fd, part, flags, 0)
		_ = unix.Close(fd)
		if openErr != nil {
			return nil, openErr
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), filepath.Join(root, rel))
	info, err := f.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("source is not an ordinary file")
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
