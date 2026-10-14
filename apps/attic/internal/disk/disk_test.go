package disk

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"lukechampine.com/blake3"
)

func TestHashConcurrentCallsAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dir := t.TempDir()
	var wg sync.WaitGroup
	for i := range 8 {
		data := bytes.Repeat([]byte{byte(i)}, 4097+i)
		path := filepath.Join(dir, fmt.Sprintf("file-%d", i))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Hash(ctx, path); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled hash: %v", err)
		}
		wg.Go(func() {
			for range 3 {
				got, n, err := Hash(context.Background(), path)
				if err != nil || got != blake3.Sum256(data) || n != int64(len(data)) {
					t.Errorf("hash %s: %x, %d bytes, %v", path, got, n, err)
				}
			}
		})
	}
	wg.Wait()
}

func BenchmarkHash(b *testing.B) {
	for _, size := range []int{4 << 10, 8 << 20} {
		b.Run(fmt.Sprintf("%dKiB", size>>10), func(b *testing.B) {
			path := filepath.Join(b.TempDir(), "file")
			if err := os.WriteFile(path, bytes.Repeat([]byte{17}, size), 0o600); err != nil {
				b.Fatal(err)
			}
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				if _, _, err := Hash(context.Background(), path); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
