package main

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func TestVerifyResolvesMissingMountedFolder(t *testing.T) {
	root := t.TempDir()
	m, parts, err := disk.Locate(root)
	if err != nil {
		t.Fatal(err)
	}
	v := store.Volume{ID: "selected", FS: m.FS, Serial: m.Serial}
	under, id, mounted, err := verificationScope(filepath.Join(root, "missing", "nested"), v.ID, []store.Volume{v})
	if err != nil {
		t.Fatal(err)
	}
	want := "/" + strings.Join(append(parts, "missing", "nested"), "/")
	if under != want || id != v.ID || mounted.Root != m.Root {
		t.Fatalf("%s, %s, %+v", under, id, mounted)
	}
}
