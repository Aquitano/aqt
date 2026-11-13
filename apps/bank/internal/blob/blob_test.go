package blob

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"lukechampine.com/blake3"
)

func TestPutStoresUnderBLAKE3Once(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("the same bytes twice")
	first, size, err := store.Put(t.Context(), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if want := blake3.Sum256(data); first != want || size != int64(len(data)) {
		t.Fatalf("Put = %s, %d; want %x, %d", first, size, want, len(data))
	}
	want := filepath.Join(store.root, first.String()[:2], first.String())
	if got := store.Path(first); got != want {
		t.Fatalf("Path = %q, want %q", got, want)
	}
	second, _, err := store.Put(t.Context(), bytes.NewReader(data))
	if err != nil || second != first {
		t.Fatalf("second Put = %s, %v", second, err)
	}
	stored, err := os.ReadFile(want)
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored %q, %v", stored, err)
	}
	entries, err := os.ReadDir(store.root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("store root holds %v, %v; want only the fan-out directory", entries, err)
	}
}
