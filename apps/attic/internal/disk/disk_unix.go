//go:build unix

package disk

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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

// Held is an open file and what the file system said about it when it was
// opened.
type Held struct {
	*os.File
	Entry Entry
}

// Hold cannot keep writers out on Unix, which has no mandatory share modes.
// Scanning runs on Windows; this lets the tests on Linux CI read files the
// same way.
func Hold(path string) (*Held, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &Held{File: f, Entry: fromInfo(filepath.Base(path), info)}, nil
}

func (f *Held) Restore() error { return nil }

// Present always holds: without Locate there is no fingerprint to compare.
func Present(Volume) bool { return true }

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

// Stat describes path itself. Only Windows has volumes mounted in folders for
// Stat to follow, so here it is Lstat.
func Stat(path string) (Entry, error) { return Lstat(path) }

// Lstat describes path itself without following a link.
func Lstat(path string) (Entry, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return Entry{}, err
	}
	return fromInfo(filepath.Base(path), info), nil
}

// Lock takes an exclusive lock on f that lasts until f is closed. It fails
// with ErrLocked instead of waiting for another process.
func Lock(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrLocked
	}
	return err
}

// SyncDir makes the entries created in dir durable.
func SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(d.Sync(), d.Close())
}

// fromInfo fills what Unix reports. Creation and access times stay zero
// until macOS scanning lands.
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
		e.Changed = changeTime(st)
	}
	return e
}

// LookupFold returns only names matching name without regard to case.
func LookupFold(dir, name string) ([]Entry, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var entries []Entry
	for {
		names, err := f.Readdirnames(128)
		for _, found := range names {
			if strings.EqualFold(found, name) {
				entries = append(entries, Entry{Name: found})
			}
		}
		if errors.Is(err, io.EOF) {
			return entries, nil
		}
		if err != nil {
			return nil, err
		}
	}
}
