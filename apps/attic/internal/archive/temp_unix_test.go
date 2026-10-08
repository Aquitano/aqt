//go:build unix

package archive

import (
	"os"
	"path/filepath"
	"testing"
)

func preventRemoval(t *testing.T, path string) func() {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	restore := func() {
		if err := os.Chmod(dir, 0o700); err != nil && !os.IsNotExist(err) {
			t.Error(err)
		}
	}
	t.Cleanup(restore)
	return restore
}
