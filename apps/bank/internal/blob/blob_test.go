package blob

import (
	"path/filepath"
	"strings"
	"testing"
)

const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

func TestValidDigest(t *testing.T) {
	if err := ValidDigest(digest); err != nil {
		t.Fatalf("a real digest was rejected: %v", err)
	}
	for _, sum := range []string{
		"", "ab", digest[:63], digest + "0",
		strings.ToUpper(digest),
		strings.Replace(digest, "9", "g", 1),
		"../../../etc/passwd",
	} {
		if err := ValidDigest(sum); err == nil {
			t.Errorf("%q was accepted", sum)
		}
	}
}

func TestPathFansOutOnTheFirstTwoCharacters(t *testing.T) {
	s := &Store{root: "/blobs"}
	want := filepath.Join("/blobs", "9f", digest)
	if got := s.Path(digest); got != want {
		t.Errorf("Path(%s) = %q, want %q", digest, got, want)
	}
}

// Path takes a plain string and cannot report an error, so the traversal has to
// be closed in Path itself: every caller that resolves a digest from argv or
// off the wire would otherwise be one "../.." from reading and writing outside
// the store.
func TestPathNeverEscapesTheStoreRoot(t *testing.T) {
	root := t.TempDir()
	s := &Store{root: root}
	for _, sum := range []string{
		"../../../etc/passwd", "..", "../sibling", "/etc/passwd",
		"a/b", "", ".", "\x00", strings.ToUpper(digest),
	} {
		got := s.Path(sum)
		rel, err := filepath.Rel(root, got)
		if err != nil {
			t.Errorf("Path(%q) = %q, which is not under %q: %v", sum, got, root, err)
			continue
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Errorf("Path(%q) = %q, which escapes %q", sum, got, root)
		}
	}
}
