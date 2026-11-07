package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func TestInspectFolderShowsInheritedPolicyWithoutCatalogue(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "Backups"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		config.FolderFile:                       "[archives]\ndepth = 0\n",
		filepath.Join("Backups", ".ATTIC.TOML"): "exclude = ['/Cache/']\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rules, files, err := inspectFolder(config.Default(), "", disk.Volume{Root: root}, []string{"Backups"})
	if err != nil {
		t.Fatal(err)
	}
	if rules.ArchiveDepth != 0 || len(files) != 2 || !strings.HasSuffix(files[1], ".ATTIC.TOML") {
		t.Fatalf("depth %d, files %v", rules.ArchiveDepth, files)
	}
	if excluded, _ := rules.Excluded([]string{"backups", "cache"}, true); !excluded {
		t.Fatal("folder rules missing from inspection")
	}
}
