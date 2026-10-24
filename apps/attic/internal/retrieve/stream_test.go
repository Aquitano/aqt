package retrieve

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"lukechampine.com/blake3"

	"github.com/aquitano/aqt/apps/attic/internal/scratch"
)

func TestCopyWithholdsTheEndOfAChangedFile(t *testing.T) {
	want := bytes.Repeat([]byte("attic "), 40_000)
	for name, onDisk := range map[string][]byte{
		"unchanged":   want,
		"last byte":   append(bytes.Clone(want[:len(want)-1]), '!'),
		"grew":        append(bytes.Clone(want), '!'),
		"shrank":      want[:len(want)-1],
		"much longer": append(bytes.Clone(want), want...),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(path, onDisk, 0o600); err != nil {
				t.Fatal(err)
			}
			f, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			src := &Source{Result: Result{Source: "/file", Size: int64(len(want))}, file: f, digest: blake3.Sum256(want)}
			var got bytes.Buffer
			err = src.Copy(&got)
			if name == "unchanged" {
				if err != nil || !bytes.Equal(got.Bytes(), want) {
					t.Fatalf("copied %d of %d bytes: %v", got.Len(), len(want), err)
				}
				return
			}
			if !errors.Is(err, scratch.ErrChanged) {
				t.Fatalf("error = %v, want ErrChanged", err)
			}
			if got.Len() > len(want)-heldBack {
				t.Fatalf("wrote %d bytes; the last %d must wait for the digest", got.Len(), heldBack)
			}
		})
	}
}
