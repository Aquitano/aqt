package archive

import (
	"context"
	"errors"
	"io"
	"sync"
	"syscall"
	"testing"
)

func TestWatchPreservesFirstDiskErrorDuringConcurrentReads(t *testing.T) {
	w := &watch{ctx: context.Background()}
	w.note(io.EOF)
	if w.failure() != nil {
		t.Fatal("EOF was treated as a disk error")
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 1000 {
				w.note(syscall.EIO)
				if !errors.Is(w.failure(), syscall.EIO) {
					t.Error("first disk error was lost")
					return
				}
			}
		})
	}
	wg.Wait()
	w.note(syscall.EBADF)
	if !errors.Is(w.failure(), syscall.EIO) {
		t.Fatal("later error overwrote first disk error")
	}
}
