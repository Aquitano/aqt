//go:build unix

package disk

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// Locate is Windows-only for now: volume fingerprints need the platform's own
// volume and device APIs. Listing and hashing work everywhere, which is what
// the tests on Linux CI exercise.
func Locate(string) (Volume, []string, error) {
	return Volume{}, nil, errors.New("scanning needs Windows for now")
}

func Mounted() []Volume { return nil }

func Open(path string) (*os.File, error) { return os.Open(path) }

func List(dir string) ([]Entry, error) {
	des, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(des))
	for _, de := range des {
		info, err := de.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return out, err
		}
		out = append(out, fromInfo(de.Name(), info))
	}
	return out, nil
}

func Stat(path string) (Entry, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Entry{}, err
	}
	return fromInfo(filepath.Base(path), info), nil
}

// fromInfo fills what every Unix reports. Creation, access and change times
// differ in name across platforms and stay zero until macOS scanning lands.
func fromInfo(name string, info fs.FileInfo) Entry {
	e := Entry{
		Name:     name,
		Dir:      info.IsDir(),
		Link:     info.Mode()&fs.ModeSymlink != 0,
		Modified: info.ModTime().UTC(),
	}
	if !e.Dir {
		e.Size = info.Size()
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		e.FileID = st.Ino
		e.LinkCount = uint64(st.Nlink) //nolint:unconvert // Nlink has different integer types across Unix platforms.
	}
	return e
}
