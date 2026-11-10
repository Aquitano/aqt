package scan

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/attic/disk"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"lukechampine.com/blake3"
)

func TestTrustedHashKeepsTimestampFastPath(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "verified bytes")
	path := filepath.Join(root, "a.txt")
	e, err := disk.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	modified, changed := e.Modified.Truncate(time.Microsecond), e.Changed.Truncate(time.Microsecond)
	stamp := store.Stamp{Size: e.Size, Modified: &modified, Changed: &changed, Digest: blake3.Sum256([]byte("verified bytes"))}
	r := &run{changeTimes: true, log: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if f, err := r.hold(ctx, path, stamp); !errors.Is(err, context.Canceled) {
		if f != nil {
			r.release(f)
		}
		t.Fatalf("legacy digest skipped verification: %v", err)
	}
	stamp.Trusted = true
	f, err := r.hold(ctx, path, stamp)
	if err != nil {
		t.Fatalf("trusted digest reread the file: %v", err)
	}
	r.release(f)
}

func TestArchiveReopensReuseVerificationAndIndependentOffsets(t *testing.T) {
	root := t.TempDir()
	write(t, root, "archive.rar", "verified bytes")
	path := filepath.Join(root, "archive.rar")
	e, err := disk.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	modified, changed := e.Modified.Truncate(time.Microsecond), e.Changed.Truncate(time.Microsecond)
	stamp := store.Stamp{Size: e.Size, Modified: &modified, Changed: &changed, Digest: blake3.Sum256([]byte("verified bytes"))}
	a := archiveFiles{r: &run{log: slog.New(slog.DiscardHandler)}, ctx: t.Context(), source: path, stamp: stamp}
	defer a.close()
	first, err := a.open(path)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	if _, err := io.ReadFull(first, buf); err != nil || string(buf) != "verified" {
		t.Fatalf("first reader: %q, %v", buf, err)
	}
	a.stamp.Digest = disk.Digest{}
	second, err := a.open(path)
	if err != nil {
		t.Fatalf("reopen repeated verification: %v", err)
	}
	if _, err := io.ReadFull(second, buf); err != nil || string(buf) != "verified" {
		t.Fatalf("second reader did not start at zero: %q, %v", buf, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if rest, err := io.ReadAll(second); err != nil || string(rest) != " bytes" {
		t.Fatalf("closing one reader affected another: %q, %v", rest, err)
	}
	held := a.held[path]
	if _, err := held.Stat(); err != nil {
		t.Fatalf("outer protection ended before listing: %v", err)
	}
	a.close()
	if _, err := held.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatal("outer handle remained open after listing")
	}
}
