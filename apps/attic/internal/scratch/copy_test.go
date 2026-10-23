package scratch

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func TestCopyChecksHashLimitAndCancellation(t *testing.T) {
	source := filepath.Join(t.TempDir(), "image.png")
	if err := os.WriteFile(source, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash, _, err := disk.Hash(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	w, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	copied, err := w.Copy(context.Background(), source, hash, 100)
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(copied); err != nil || string(data) != "original" {
		t.Fatalf("copy %q %v", data, err)
	}
	if _, err := w.Copy(context.Background(), source, hash, 1); !errors.Is(err, ErrTooBig) {
		t.Fatalf("cap: %v", err)
	}
	if err := os.WriteFile(source, []byte("modified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Copy(context.Background(), source, hash, 100); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := w.Copy(ctx, source, hash, 100); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	files, err := os.ReadDir(w.Path)
	if err != nil || len(files) != 2 {
		t.Fatalf("partial copies left behind: %v %v", files, err)
	}
}

func TestCopyDistinguishesScratchAndSourceFailures(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	digest, _, err := disk.Hash(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	w := &Workspace{Path: filepath.Join(t.TempDir(), "missing")}
	if _, err := w.Copy(context.Background(), source, digest, 100); !errors.As(err, new(WriteError)) {
		t.Fatalf("scratch failure: %v", err)
	}
	if _, err := w.Copy(context.Background(), source+"missing", digest, 100); err == nil || errors.As(err, new(WriteError)) {
		t.Fatalf("source failure: %v", err)
	}
}

func TestRelativeWorkspaceProducesAbsoluteCopies(t *testing.T) {
	base := t.TempDir()
	source := filepath.Join(base, "source.txt")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	digest, _, err := disk.Hash(t.Context(), source)
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(base)
	w, err := New(".", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	copied, err := w.Copy(t.Context(), source, digest, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(copied) {
		t.Fatalf("relative copy path: %s", copied)
	}
	f, err := disk.Open(copied)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}
