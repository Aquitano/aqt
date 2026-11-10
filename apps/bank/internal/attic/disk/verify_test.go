package disk

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestHashOrdinaryRefusesLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "file"), []byte("bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "dir"), filepath.Join(root, "link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, _, err := HashOrdinary(t.Context(), root, filepath.Join("link", "file")); !errors.Is(err, ErrNotOrdinary) {
		t.Fatalf("followed ancestor link: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "dir", "file"), filepath.Join(root, "file-link")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := HashOrdinary(t.Context(), root, "file-link"); !errors.Is(err, ErrNotOrdinary) {
		t.Fatalf("followed file link: %v", err)
	}
}

func TestHashOrdinaryCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, n, err := HashOrdinary(ctx, t.TempDir(), "absent"); !errors.Is(err, context.Canceled) || n != 0 {
		t.Fatalf("%d, %v", n, err)
	}
}
