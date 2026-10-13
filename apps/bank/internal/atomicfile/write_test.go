package atomicfile

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, errors.New("interrupted") }

func TestWritePreservesCompleteFileAndRestrictsPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := Write(path, strings.NewReader("old")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("new file permissions: %v, %v", info, err)
	}
	if err := os.Chmod(path, 0640); err != nil {
		t.Fatal(err)
	}
	if err := Write(path, io.MultiReader(strings.NewReader("partial"), brokenReader{})); err == nil {
		t.Fatal("failed reader succeeded")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "old" {
		t.Fatalf("failed write replaced file: %q, %v", raw, err)
	}
	if err := Write(path, strings.NewReader("replacement")); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("replacement permissions are not owner-only: %v, %v", info, err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v, %v", entries, err)
	}
}
