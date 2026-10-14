package metadata

import (
	"context"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func BenchmarkReadBatch(b *testing.B) {
	binary, err := exec.LookPath("exiftool")
	if err != nil {
		b.Skip("ExifTool is not installed")
	}
	dir := b.TempDir()
	paths := make([]string, 256)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("image-%03d.png", i))
		f, err := os.Create(paths[i])
		if err != nil {
			b.Fatal(err)
		}
		err = png.Encode(f, image.NewGray(image.Rect(0, 0, 1, 1)))
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			b.Fatalf("PNG fixture: %v, %v", err, closeErr)
		}
	}
	for _, size := range []int{16, 64} {
		b.Run(fmt.Sprintf("%d", size), func(b *testing.B) {
			for b.Loop() {
				for i := 0; i < len(paths); i += size {
					results, err := Read(context.Background(), binary, paths[i:i+size])
					if err != nil || len(results) != size {
						b.Fatalf("batch: %d results, %v", len(results), err)
					}
				}
			}
		})
	}
}
