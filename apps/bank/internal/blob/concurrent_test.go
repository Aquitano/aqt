package blob

import (
	"bytes"
	"os"
	"sync"
	"testing"
)

func TestConcurrentSameContentPut(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("concurrent upload\n"), 4096)
	start := make(chan struct{})
	results := make(chan error, 32)
	digests := make(chan string, 32)
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			<-start
			digest, _, err := store.Put(bytes.NewReader(content))
			results <- err
			digests <- digest
		})
	}
	close(start)
	workers.Wait()
	close(results)
	close(digests)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	for digest := range digests {
		got, err := os.ReadFile(store.Path(digest))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, content) {
			t.Fatal("concurrent upload corrupted bytes")
		}
	}
}
