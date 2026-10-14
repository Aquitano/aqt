package scratch

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func BenchmarkCopy(b *testing.B) {
	const size = 64 << 20
	source := filepath.Join(b.TempDir(), "source")
	if err := os.WriteFile(source, bytes.Repeat([]byte{17}, size), 0o600); err != nil {
		b.Fatal(err)
	}
	digest, _, err := disk.Hash(context.Background(), source)
	if err != nil {
		b.Fatal(err)
	}
	w, err := New(b.TempDir(), nil)
	if err != nil {
		b.Fatal(err)
	}
	defer w.Close()
	b.SetBytes(size)
	b.ReportAllocs()
	for b.Loop() {
		path, err := w.Copy(context.Background(), source, digest, size)
		if err != nil {
			b.Fatal(err)
		}
		if err := os.Remove(path); err != nil {
			b.Fatal(err)
		}
	}
}
